import { Notice, Plugin } from "obsidian";
import { Socket, io } from "socket.io-client";
import type {
	SyncServerSettings,
	FileCreatedEvent,
	FileModifiedEvent,
	FileDeletedEvent,
	FileRenamedEvent,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { SyncServerSettingTab } from "./settings";
import { SyncService } from "./sync";
import { SettingsSyncService } from "./settingsSync";
import { EventHandlers } from "./handlers";
import { confirm } from "./modals";

export default class SyncServerPlugin extends Plugin {
	settings: SyncServerSettings;
	socket: Socket | null = null;
	pendingPaths: Set<string> = new Set();
	private handlers: EventHandlers;
	private syncService: SyncService;
	private settingsSyncService: SettingsSyncService;

	async onload() {
		await this.loadSettings();

		this.handlers = new EventHandlers(
			this.app.vault,
			() => this.socket,
			(path) => this.markPending(path),
			(path) => this.clearPending(path),
			(path) => this.isPending(path),
			(path) => this.ensureParentFolder(path),
		);

		this.syncService = new SyncService(
			this.app.vault,
			this.settings,
			this.socket,
			this.pendingPaths,
			(path) => this.markPending(path),
			(path) => this.clearPending(path),
		);

		this.settingsSyncService = new SettingsSyncService(
			this.app.vault,
			this.settings,
		);

		if (this.settings.url && this.settings.apiKey) {
			this.connectSocket();
		}

		this.registerEvent(
			this.app.vault.on("create", (file) =>
				this.handlers.handleLocalCreate(file),
			),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) =>
				this.handlers.handleLocalModify(file),
			),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) =>
				this.handlers.handleLocalDelete(file),
			),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) =>
				this.handlers.handleLocalRename(file, oldPath),
			),
		);

		this.addSettingTab(new SyncServerSettingTab(this.app, this));

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.performInitialSync(),
		});

		this.addCommand({
			id: "reconnect",
			name: "Reconnect to server",
			callback: () => this.connectSocket(),
		});

		this.addCommand({
			id: "force-push-local",
			name: "Force sync store state to local state",
			callback: () => this.forceLocalToServer(),
		});

		this.addCommand({
			id: "disconnect",
			name: "Disconnect from server",
			callback: () => this.disconnectSocket(),
		});

		this.addCommand({
			id: "push-settings",
			name: "Push vault settings to server",
			callback: () => this.pushSettings(),
		});

		this.addCommand({
			id: "pull-settings",
			name: "Pull vault settings from server",
			callback: () => this.pullSettings(),
		});
	}

	onunload() {
		if (this.socket?.connected) {
			this.socket.disconnect();
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	markPending(path: string) {
		this.pendingPaths.add(path);
	}

	clearPending(path: string) {
		setTimeout(() => this.pendingPaths.delete(path), 200);
	}

	isPending(path: string): boolean {
		return this.pendingPaths.has(path);
	}

	disconnectSocket() {
		if (this.socket?.connected) {
			this.socket.disconnect();
			new Notice("Disconnected from sync server");
			console.log("[Sync] Manually disconnected from server");
		} else {
			new Notice("Not connected to sync server");
		}
	}

	connectSocket() {
		if (this.socket?.connected) {
			this.socket.disconnect();
		}

		if (!this.settings.url || !this.settings.apiKey) {
			new Notice("Sync server URL and API key are required");
			return;
		}

		this.socket = io(this.settings.url, {
			reconnectionAttempts: 5,
			reconnectionDelay: 5000,
			reconnectionDelayMax: 30000,
			transports: ["websocket"],
			query: { apiKey: this.settings.apiKey },
		});

		this.socket.on("connect", () => {
			new Notice("Connected to sync server");
			console.log("[Sync] Connected to server");
			this.performInitialSync();
		});

		this.socket.on("connect_error", (err) => {
			new Notice(`Sync connection failed: ${err.message}`);
			console.error("[Sync] Connection error:", err.message);
		});

		this.socket.on("disconnect", (reason) => {
			if (reason !== "io client disconnect") {
				new Notice("Disconnected from sync server");
				console.log("[Sync] Disconnected:", reason);
			}
		});

		this.socket.on("file-created", (event: FileCreatedEvent) => {
			this.handlers.handleServerFileCreated(event);
		});

		this.socket.on("file-modified", (event: FileModifiedEvent) => {
			this.handlers.handleServerFileModified(event);
		});

		this.socket.on("file-deleted", (event: FileDeletedEvent) => {
			this.handlers.handleServerFileDeleted(event);
		});

		this.socket.on("file-renamed", (event: FileRenamedEvent) => {
			this.handlers.handleServerFileRenamed(event);
		});

		this.updateSyncService();
	}

	private updateSyncService() {
		this.syncService = new SyncService(
			this.app.vault,
			this.settings,
			this.socket,
			this.pendingPaths,
			(path) => this.markPending(path),
			(path) => this.clearPending(path),
		);
	}

	performInitialSync() {
		this.updateSyncService();
		return this.syncService.performInitialSync();
	}

	async forceLocalToServer() {
		const confirmed = await confirm(
			this.app,
			"This will DELETE all files on the server and replace them with your local files. This cannot be undone. Continue?",
		);
		if (!confirmed) return;

		this.updateSyncService();
		return this.syncService.forceLocalToServer();
	}

	async pushSettings() {
		const confirmed = await confirm(
			this.app,
			"This will replace all vault settings on the server with your local .obsidian/ settings. Continue?",
		);
		if (!confirmed) return;

		this.settingsSyncService = new SettingsSyncService(
			this.app.vault,
			this.settings,
		);
		return this.settingsSyncService.pushSettings();
	}

	async pullSettings() {
		const confirmed = await confirm(
			this.app,
			"This will replace your local .obsidian/ settings with settings from the server. You will need to restart Obsidian after this operation. Continue?",
		);
		if (!confirmed) return;

		this.settingsSyncService = new SettingsSyncService(
			this.app.vault,
			this.settings,
		);
		return this.settingsSyncService.pullSettings();
	}

	/**
	 * Ensure all ancestor folders exist for a given file path.
	 * Creates directories recursively from root to leaf.
	 */
	async ensureParentFolder(filePath: string) {
		const parts = filePath.split("/");
		parts.pop(); // Remove the filename

		if (parts.length === 0) return;

		// Build each ancestor path from root to leaf
		for (let i = 1; i <= parts.length; i++) {
			const folderPath = parts.slice(0, i).join("/");
			const existing = this.app.vault.getAbstractFileByPath(folderPath);

			if (!existing) {
				try {
					await this.app.vault.createFolder(folderPath);
				} catch (err) {
					if (!String(err).includes("Folder already exists")) {
						throw err;
					}
				}
			}
		}
	}
}
