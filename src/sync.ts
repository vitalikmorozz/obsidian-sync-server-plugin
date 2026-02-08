import { Notice, TFile, Vault } from "obsidian";
import type { Socket } from "socket.io-client";
import type {
	SyncServerSettings,
	FileListResponse,
	FileContentResponse,
} from "./types";
import { isBinaryFile, computeHash } from "./utils";

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
			console.log(`[Sync] Server has ${serverFiles.size} files`);

			const localFiles = this.vault
				.getFiles()
				.filter((f) => !isBinaryFile(f.path));
			const localPaths = new Set(localFiles.map((f) => f.path));
			console.log(`[Sync] Local vault has ${localFiles.length} files`);

			let downloaded = 0;
			let updated = 0;
			let uploaded = 0;

			for (const [path] of serverFiles) {
				if (!localPaths.has(path)) {
					await this.downloadFile(path);
					downloaded++;
				}
			}

			for (const localFile of localFiles) {
				const serverInfo = serverFiles.get(localFile.path);
				if (serverInfo) {
					try {
						const content = await this.vault.read(localFile);
						const localHash = await computeHash(content);

						if (localHash !== serverInfo.hash) {
							console.log(
								`[Sync] Hash mismatch for ${localFile.path}, downloading server version`,
							);
							await this.downloadFile(localFile.path);
							updated++;
						}
					} catch (err) {
						console.error(
							"[Sync] Failed to compare:",
							localFile.path,
							err,
						);
					}
				}
			}

			for (const localFile of localFiles) {
				if (!serverFiles.has(localFile.path)) {
					try {
						const content = await this.vault.read(localFile);
						this.socket?.emit(
							"modified-file",
							{ path: localFile.path, content },
							() => {},
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
				`[Sync] Downloaded ${downloaded}, updated ${updated}, uploaded ${uploaded}`,
			);
			new Notice(
				`Sync complete: ${downloaded} new, ${updated} updated, ${uploaded} uploaded`,
			);
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

			const localFiles = this.vault
				.getFiles()
				.filter((f) => !isBinaryFile(f.path));

			let uploaded = 0;
			for (const file of localFiles) {
				try {
					const content = await this.vault.read(file);
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
				`[Sync] Force push complete: ${uploaded} files uploaded`,
			);
			new Notice(
				`Force sync complete: ${deleted} deleted, ${uploaded} uploaded`,
			);
		} catch (err) {
			console.error("[Sync] Force push failed:", err);
			new Notice("Force sync failed. Check console for details.");
		}
	}

	async downloadFile(path: string) {
		try {
			const response = await fetch(
				`${this.settings.url}/api/v1/files?path=${encodeURIComponent(path)}`,
				{ headers: { "X-API-Key": this.settings.apiKey } },
			);

			if (!response.ok) {
				throw new Error(`Failed to download: ${response.status}`);
			}

			const data: FileContentResponse = await response.json();

			this.markPending(path);
			try {
				const existing = this.vault.getAbstractFileByPath(path);
				if (existing instanceof TFile) {
					await this.vault.modify(existing, data.content);
					console.log("[Sync] Updated:", path);
				} else {
					await this.ensureParentFolder(path);
					await this.vault.create(path, data.content);
					console.log("[Sync] Downloaded:", path);
				}
			} finally {
				this.clearPending(path);
			}
		} catch (err) {
			console.error("[Sync] Failed to download:", path, err);
		}
	}

	private async fetchServerFiles(): Promise<Map<string, { hash: string }>> {
		const serverFiles = new Map<string, { hash: string }>();
		let offset = 0;
		const limit = 1000;

		while (true) {
			const response = await fetch(
				`${this.settings.url}/api/v1/files?limit=${limit}&offset=${offset}`,
				{ headers: { "X-API-Key": this.settings.apiKey } },
			);

			if (!response.ok) {
				throw new Error(
					`Failed to fetch file list: ${response.status}`,
				);
			}

			const data: FileListResponse = await response.json();
			data.files.forEach((f) => {
				if (!isBinaryFile(f.path)) {
					serverFiles.set(f.path, { hash: f.hash });
				}
			});

			if (data.files.length < limit) break;
			offset += limit;
		}

		return serverFiles;
	}

	private async ensureParentFolder(filePath: string) {
		const parts = filePath.split("/");
		parts.pop();

		if (parts.length === 0) return;

		const folderPath = parts.join("/");
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
