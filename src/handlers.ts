import { Notice, TFile, Vault, TAbstractFile } from "obsidian";
import type { Socket } from "socket.io-client";
import type {
	AckResponse,
	FileCreatedEvent,
	FileModifiedEvent,
	FileDeletedEvent,
	FileRenamedEvent,
} from "./types";
import { isBinaryFile } from "./utils";

export class EventHandlers {
	private vault: Vault;
	private socket: Socket | null;
	private markPending: (path: string) => void;
	private clearPending: (path: string) => void;
	private isPending: (path: string) => boolean;
	private ensureParentFolder: (path: string) => Promise<void>;

	constructor(
		vault: Vault,
		getSocket: () => Socket | null,
		markPending: (path: string) => void,
		clearPending: (path: string) => void,
		isPending: (path: string) => boolean,
		ensureParentFolder: (path: string) => Promise<void>,
	) {
		this.vault = vault;
		this.socket = null;
		this.markPending = markPending;
		this.clearPending = clearPending;
		this.isPending = isPending;
		this.ensureParentFolder = ensureParentFolder;

		Object.defineProperty(this, "socket", {
			get: getSocket,
		});
	}

	handleAck(response: AckResponse, action: string) {
		if (!response.success) {
			new Notice(`Sync error: ${response.error.message}`);
			console.error(`[Sync] ${action} failed:`, response.error);
		}
	}

	async handleServerFileCreated(event: FileCreatedEvent) {
		if (isBinaryFile(event.path)) return;

		console.log("[Sync] Server file created:", event.path);

		this.markPending(event.path);
		try {
			const existing = this.vault.getAbstractFileByPath(event.path);
			if (!existing) {
				await this.ensureParentFolder(event.path);
				await this.vault.create(event.path, event.content);
				console.log("[Sync] Created local file:", event.path);
			}
		} catch (err) {
			console.error("[Sync] Failed to create file:", event.path, err);
		} finally {
			this.clearPending(event.path);
		}
	}

	async handleServerFileModified(event: FileModifiedEvent) {
		if (isBinaryFile(event.path)) return;

		console.log("[Sync] Server file modified:", event.path);

		this.markPending(event.path);
		try {
			const file = this.vault.getAbstractFileByPath(event.path);
			if (file instanceof TFile) {
				await this.vault.modify(file, event.content);
				console.log("[Sync] Modified local file:", event.path);
			} else if (!file) {
				await this.ensureParentFolder(event.path);
				await this.vault.create(event.path, event.content);
				console.log(
					"[Sync] Created local file (from modify):",
					event.path,
				);
			}
		} catch (err) {
			console.error("[Sync] Failed to modify file:", event.path, err);
		} finally {
			this.clearPending(event.path);
		}
	}

	async handleServerFileDeleted(event: FileDeletedEvent) {
		if (isBinaryFile(event.path)) return;

		console.log("[Sync] Server file deleted:", event.path);

		this.markPending(event.path);
		try {
			const file = this.vault.getAbstractFileByPath(event.path);
			if (file instanceof TFile) {
				await this.vault.delete(file);
				console.log("[Sync] Deleted local file:", event.path);
			}
		} catch (err) {
			console.error("[Sync] Failed to delete file:", event.path, err);
		} finally {
			this.clearPending(event.path);
		}
	}

	async handleServerFileRenamed(event: FileRenamedEvent) {
		if (isBinaryFile(event.oldPath) || isBinaryFile(event.newPath)) return;

		console.log(
			"[Sync] Server file renamed:",
			event.oldPath,
			"->",
			event.newPath,
		);

		this.markPending(event.oldPath);
		this.markPending(event.newPath);
		try {
			const file = this.vault.getAbstractFileByPath(event.oldPath);
			if (file instanceof TFile) {
				await this.ensureParentFolder(event.newPath);
				await this.vault.rename(file, event.newPath);
				console.log(
					"[Sync] Renamed local file:",
					event.oldPath,
					"->",
					event.newPath,
				);
			} else if (!file) {
				await this.ensureParentFolder(event.newPath);
				await this.vault.create(event.newPath, event.content);
				console.log(
					"[Sync] Created local file (from rename):",
					event.newPath,
				);
			}
		} catch (err) {
			console.error("[Sync] Failed to rename file:", event.oldPath, err);
		} finally {
			this.clearPending(event.oldPath);
			this.clearPending(event.newPath);
		}
	}

	async handleLocalCreate(file: TAbstractFile) {
		if (!(file instanceof TFile)) return;
		if (isBinaryFile(file.path)) return;
		if (!this.socket?.connected) return;
		if (this.isPending(file.path)) return;

		setTimeout(async () => {
			try {
				const content = await this.vault.read(file);
				this.socket?.emit(
					"modified-file",
					{ path: file.path, content },
					(response: AckResponse) =>
						this.handleAck(response, "Create"),
				);
				console.log("[Sync] Sent create:", file.path);
			} catch (err) {
				console.error("[Sync] Failed to send create:", file.path, err);
			}
		}, 100);
	}

	async handleLocalModify(file: TAbstractFile) {
		if (!(file instanceof TFile)) return;
		if (isBinaryFile(file.path)) return;
		if (!this.socket?.connected) return;
		if (this.isPending(file.path)) return;

		try {
			const content = await this.vault.read(file);
			this.socket.emit(
				"modified-file",
				{ path: file.path, content },
				(response: AckResponse) => this.handleAck(response, "Modify"),
			);
			console.log("[Sync] Sent modify:", file.path);
		} catch (err) {
			console.error("[Sync] Failed to send modify:", file.path, err);
		}
	}

	handleLocalDelete(file: TAbstractFile) {
		if (!(file instanceof TFile)) return;
		if (isBinaryFile(file.path)) return;
		if (!this.socket?.connected) return;
		if (this.isPending(file.path)) return;

		this.socket.emit(
			"deleted-file",
			{ path: file.path },
			(response: AckResponse) => this.handleAck(response, "Delete"),
		);
		console.log("[Sync] Sent delete:", file.path);
	}

	handleLocalRename(file: TAbstractFile, oldPath: string) {
		if (!(file instanceof TFile)) return;
		if (isBinaryFile(file.path) || isBinaryFile(oldPath)) return;
		if (!this.socket?.connected) return;
		if (this.isPending(file.path) || this.isPending(oldPath)) return;

		this.socket.emit(
			"renamed-file",
			{ oldPath, newPath: file.path },
			(response: AckResponse) => this.handleAck(response, "Rename"),
		);
		console.log("[Sync] Sent rename:", oldPath, "->", file.path);
	}
}
