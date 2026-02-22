import { Notice, TFile, TFolder, Vault } from "obsidian";
import type { Socket } from "socket.io-client";
import type {
	SyncServerSettings,
	FileListResponse,
	FileContentResponse,
} from "./types";
import {
	isBinaryFile,
	computeHash,
	encodeToBase64,
	decodeFromBase64,
	checkContentSize,
} from "./utils";

export class SyncService {
	private vault: Vault;
	private settings: SyncServerSettings;
	private socket: Socket | null;
	private pendingPaths: Set<string>;
	private markPending: (path: string) => void;
	private clearPending: (path: string) => void;

	constructor(
		vault: Vault,
		settings: SyncServerSettings,
		socket: Socket | null,
		pendingPaths: Set<string>,
		markPending: (path: string) => void,
		clearPending: (path: string) => void,
	) {
		this.vault = vault;
		this.settings = settings;
		this.socket = socket;
		this.pendingPaths = pendingPaths;
		this.markPending = markPending;
		this.clearPending = clearPending;
	}

	async performInitialSync() {
		if (!this.settings.url || !this.settings.apiKey) {
			console.log("[Sync] Cannot sync: missing settings");
			return;
		}

		console.log("[Sync] Starting initial sync...");
		new Notice("Starting sync...");

		try {
			const serverFiles = await this.fetchServerFiles();
			const activeCount = [...serverFiles.values()].filter(
				(f) => !f.deleted,
			).length;
			const tombstoneCount = [...serverFiles.values()].filter(
				(f) => f.deleted,
			).length;
			console.log(
				`[Sync] Server has ${activeCount} active files, ${tombstoneCount} tombstones`,
			);

			// Include ALL files (no binary filtering)
			const localFiles = this.vault.getFiles();
			const localPaths = new Set(localFiles.map((f) => f.path));
			console.log(`[Sync] Local vault has ${localFiles.length} files`);

			let downloaded = 0;
			let merged = 0;
			let uploaded = 0;
			let deleted = 0;
			let skipped = 0;

			// Phase 1: Delete local files that are tombstoned on the server
			for (const [path, info] of serverFiles) {
				if (info.deleted && localPaths.has(path)) {
					const file = this.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						try {
							this.markPending(path);
							await this.vault.delete(file);
							console.log(
								"[Sync] Deleted local file (server tombstone):",
								path,
							);
							deleted++;
							await this.cleanupEmptyAncestors(path);
						} catch (err) {
							console.error(
								"[Sync] Failed to delete:",
								path,
								err,
							);
						} finally {
							this.clearPending(path);
						}
					}
				}
			}

			// Phase 2: Download files that exist on server (active) but NOT locally
			for (const [path, info] of serverFiles) {
				if (!info.deleted && !localPaths.has(path)) {
					await this.downloadFile(path, info.isBinary);
					downloaded++;
				}
			}

			// Phase 3: For files that exist BOTH locally and on server (active), compare hashes
			// Uses last-edit-wins: compare local mtime vs server updatedAt
			for (const localFile of localFiles) {
				const serverInfo = serverFiles.get(localFile.path);
				if (serverInfo && !serverInfo.deleted) {
					try {
						// Read content as appropriate type and compute hash on the stored representation
						let localContent: string;
						if (isBinaryFile(localFile.path)) {
							const buffer =
								await this.vault.readBinary(localFile);
							localContent = encodeToBase64(buffer);
						} else {
							localContent = await this.vault.read(localFile);
						}
						const localHash = await computeHash(localContent);

						if (localHash !== serverInfo.hash) {
							const serverTime = new Date(
								serverInfo.updatedAt,
							).getTime();
							const localTime = localFile.stat.mtime;

							if (localTime > serverTime) {
								// Local is newer — upload to server
								const sizeError = checkContentSize(
									localContent,
									localFile.path,
								);
								if (sizeError) {
									console.warn(
										"[Sync] Skipped upload:",
										sizeError,
									);
									skipped++;
								} else {
									console.log(
										`[Sync] Hash mismatch for ${localFile.path}, local is newer — uploading`,
									);
									this.socket?.emit(
										"modified-file",
										{
											path: localFile.path,
											content: localContent,
										},
										(response: any) => {
											if (response && !response.success) {
												console.error(
													`[Sync] Upload failed for ${localFile.path}:`,
													response.error,
												);
											}
										},
									);
								}
							} else {
								// Server is newer (or equal) — download from server
								console.log(
									`[Sync] Hash mismatch for ${localFile.path}, server is newer — downloading`,
								);
								await this.downloadFile(
									localFile.path,
									isBinaryFile(localFile.path),
								);
							}
							merged++;
						}
					} catch (err) {
						console.error(
							"[Sync] Failed to resolve:",
							localFile.path,
							err,
						);
					}
				}
			}

			// Phase 4: Upload files that exist locally but NOT on server at all
			for (const localFile of localFiles) {
				if (!serverFiles.has(localFile.path)) {
					try {
						let content: string;
						if (isBinaryFile(localFile.path)) {
							const buffer =
								await this.vault.readBinary(localFile);
							content = encodeToBase64(buffer);
						} else {
							content = await this.vault.read(localFile);
						}
						const sizeError = checkContentSize(
							content,
							localFile.path,
						);
						if (sizeError) {
							console.warn("[Sync] Skipped upload:", sizeError);
							skipped++;
							continue;
						}
						this.socket?.emit(
							"modified-file",
							{ path: localFile.path, content },
							(response: any) => {
								if (response && !response.success) {
									console.error(
										`[Sync] Upload failed for ${localFile.path}:`,
										response.error,
									);
								}
							},
						);
						uploaded++;
					} catch (err) {
						console.error(
							"[Sync] Failed to upload:",
							localFile.path,
							err,
						);
					}
				}
			}

			console.log(
				`[Sync] Downloaded ${downloaded}, merged ${merged}, uploaded ${uploaded}, deleted ${deleted}, skipped ${skipped}`,
			);
			const parts = [
				`${downloaded} new`,
				`${merged} merged`,
				`${uploaded} uploaded`,
				`${deleted} deleted`,
			];
			if (skipped > 0) {
				parts.push(`${skipped} skipped (too large)`);
			}
			new Notice(`Sync complete: ${parts.join(", ")}`);
		} catch (err) {
			console.error("[Sync] Initial sync failed:", err);
			new Notice("Sync failed. Check console for details.");
		}
	}

	async forceLocalToServer() {
		if (!this.settings.url || !this.settings.apiKey) {
			new Notice("Sync server URL and API key are required");
			return;
		}

		new Notice("Force syncing local state to server...");
		console.log("[Sync] Starting force push to server...");

		try {
			const deleteResponse = await fetch(
				`${this.settings.url}/api/v1/files/all`,
				{
					method: "DELETE",
					headers: { "X-API-Key": this.settings.apiKey },
				},
			);

			if (!deleteResponse.ok) {
				throw new Error(
					`Failed to clear server: ${deleteResponse.status}`,
				);
			}

			const { deleted } = await deleteResponse.json();
			console.log(`[Sync] Deleted ${deleted} files from server`);

			// Include ALL files (no binary filtering)
			const localFiles = this.vault.getFiles();

			let uploaded = 0;
			let forceSkipped = 0;
			for (const file of localFiles) {
				try {
					let content: string;
					if (isBinaryFile(file.path)) {
						const buffer = await this.vault.readBinary(file);
						content = encodeToBase64(buffer);
					} else {
						content = await this.vault.read(file);
					}
					const sizeError = checkContentSize(content, file.path);
					if (sizeError) {
						console.warn("[Sync] Skipped upload:", sizeError);
						forceSkipped++;
						continue;
					}
					const response = await fetch(
						`${this.settings.url}/api/v1/files`,
						{
							method: "PUT",
							headers: {
								"Content-Type": "application/json",
								"X-API-Key": this.settings.apiKey,
							},
							body: JSON.stringify({ path: file.path, content }),
						},
					);

					if (!response.ok) {
						console.error(
							`[Sync] Failed to upload ${file.path}: ${response.status}`,
						);
					} else {
						uploaded++;
					}
				} catch (err) {
					console.error(`[Sync] Failed to upload ${file.path}:`, err);
				}
			}

			console.log(
				`[Sync] Force push complete: ${uploaded} uploaded, ${forceSkipped} skipped`,
			);
			let msg = `Force sync complete: ${deleted} deleted, ${uploaded} uploaded`;
			if (forceSkipped > 0) {
				msg += `, ${forceSkipped} skipped (too large)`;
			}
			new Notice(msg);
		} catch (err) {
			console.error("[Sync] Force push failed:", err);
			new Notice("Force sync failed. Check console for details.");
		}
	}

	async downloadFile(path: string, binary?: boolean) {
		try {
			const response = await fetch(
				`${this.settings.url}/api/v1/files?path=${encodeURIComponent(path)}`,
				{ headers: { "X-API-Key": this.settings.apiKey } },
			);

			if (!response.ok) {
				throw new Error(`Failed to download: ${response.status}`);
			}

			const data: FileContentResponse = await response.json();
			const isBin = binary ?? data.isBinary;

			this.markPending(path);
			try {
				const existing = this.vault.getAbstractFileByPath(path);
				if (existing instanceof TFile) {
					if (isBin) {
						const buffer = decodeFromBase64(data.content);
						await this.vault.modifyBinary(existing, buffer);
					} else {
						await this.vault.modify(existing, data.content);
					}
					console.log("[Sync] Updated:", path);
				} else {
					await this.ensureParentFolder(path);
					if (isBin) {
						const buffer = decodeFromBase64(data.content);
						await this.vault.createBinary(path, buffer);
					} else {
						await this.vault.create(path, data.content);
					}
					console.log("[Sync] Downloaded:", path);
				}
			} finally {
				this.clearPending(path);
			}
		} catch (err) {
			console.error("[Sync] Failed to download:", path, err);
		}
	}

	private async fetchServerFiles(): Promise<
		Map<
			string,
			{
				hash: string;
				deleted: boolean;
				isBinary: boolean;
				updatedAt: string;
			}
		>
	> {
		const serverFiles = new Map<
			string,
			{
				hash: string;
				deleted: boolean;
				isBinary: boolean;
				updatedAt: string;
			}
		>();
		let offset = 0;
		const limit = 1000;

		while (true) {
			const response = await fetch(
				`${this.settings.url}/api/v1/files?limit=${limit}&offset=${offset}&include_deleted=true`,
				{ headers: { "X-API-Key": this.settings.apiKey } },
			);

			if (!response.ok) {
				throw new Error(
					`Failed to fetch file list: ${response.status}`,
				);
			}

			const data: FileListResponse = await response.json();
			data.files.forEach((f) => {
				// Include ALL files (no binary filtering)
				serverFiles.set(f.path, {
					hash: f.hash,
					deleted: !!f.expiresAt,
					isBinary: f.isBinary,
					updatedAt: f.updatedAt,
				});
			});

			if (data.files.length < limit) break;
			offset += limit;
		}

		return serverFiles;
	}

	/**
	 * Walk up the directory tree from a file path and delete any empty folders.
	 * Stops at the vault root.
	 */
	private async cleanupEmptyAncestors(filePath: string) {
		const parts = filePath.split("/");
		parts.pop(); // Remove the filename

		while (parts.length > 0) {
			const folderPath = parts.join("/");
			const folder = this.vault.getAbstractFileByPath(folderPath);

			if (folder instanceof TFolder && folder.children.length === 0) {
				try {
					await this.vault.delete(folder);
					console.log("[Sync] Deleted empty folder:", folderPath);
				} catch (err) {
					console.error(
						"[Sync] Failed to delete empty folder:",
						folderPath,
						err,
					);
					break;
				}
			} else {
				break;
			}

			parts.pop();
		}
	}

	/**
	 * Ensure all ancestor folders exist for a given file path.
	 * Creates directories recursively from root to leaf.
	 */
	private async ensureParentFolder(filePath: string) {
		const parts = filePath.split("/");
		parts.pop(); // Remove the filename

		if (parts.length === 0) return;

		// Build each ancestor path from root to leaf
		for (let i = 1; i <= parts.length; i++) {
			const folderPath = parts.slice(0, i).join("/");
			const existing = this.vault.getAbstractFileByPath(folderPath);

			if (!existing) {
				try {
					await this.vault.createFolder(folderPath);
				} catch (err) {
					if (!String(err).includes("Folder already exists")) {
						throw err;
					}
				}
			}
		}
	}
}
