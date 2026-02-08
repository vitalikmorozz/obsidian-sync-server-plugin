import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import { Socket, io } from "socket.io-client";

// ============================================
// Types
// ============================================

interface SyncServerSettings {
	url: string;
	apiKey: string;
}

const DEFAULT_SETTINGS: SyncServerSettings = {
	url: "",
	apiKey: "",
};

// Acknowledgment response from server
type AckResponse =
	| { success: true; hash?: string }
	| { success: false; error: { code: string; message: string } };

// Server -> Client events
interface FileCreatedEvent {
	path: string;
	content: string;
	hash: string;
	size: number;
	createdAt: string;
}

interface FileModifiedEvent {
	path: string;
	content: string;
	hash: string;
	size: number;
	updatedAt: string;
}

interface FileDeletedEvent {
	path: string;
	deletedAt: string;
}

interface FileRenamedEvent {
	oldPath: string;
	newPath: string;
	content: string;
	hash: string;
	size: number;
	updatedAt: string;
}

// File list response from REST API
interface FileListResponse {
	files: Array<{
		path: string;
		hash: string;
		size: number;
		createdAt: string;
		updatedAt: string;
	}>;
	total: number;
	limit: number;
	offset: number;
}

interface FileContentResponse {
	path: string;
	content: string;
	hash: string;
	size: number;
	createdAt: string;
	updatedAt: string;
}

// ============================================
// Binary file detection
// ============================================

const BINARY_EXTENSIONS = new Set([
	// Images
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"webp",
	"ico",
	"svg",
	"tiff",
	"tif",
	// Documents
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"odt",
	"ods",
	"odp",
	// Archives
	"zip",
	"rar",
	"7z",
	"tar",
	"gz",
	"bz2",
	"xz",
	// Audio
	"mp3",
	"wav",
	"ogg",
	"flac",
	"aac",
	"wma",
	"m4a",
	// Video
	"mp4",
	"avi",
	"mkv",
	"mov",
	"wmv",
	"flv",
	"webm",
	// Executables
	"exe",
	"dll",
	"so",
	"dylib",
	"bin",
	// Fonts
	"ttf",
	"otf",
	"woff",
	"woff2",
	"eot",
	// Other binary
	"db",
	"sqlite",
	"sqlite3",
]);

function isBinaryFile(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return BINARY_EXTENSIONS.has(ext);
}

/**
 * Compute SHA-256 hash of content (same format as server: "sha256:xxxx...")
 */
async function computeHash(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	return `sha256:${hex}`;
}

// ============================================
// Confirmation Modal
// ============================================

class ConfirmModal extends Modal {
	message: string;
	onResult: (confirmed: boolean) => void;

	constructor(
		app: App,
		message: string,
		onResult: (confirmed: boolean) => void,
	) {
		super(app);
		this.message = message;
		this.onResult = onResult;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });

		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		buttonContainer
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => {
				this.onResult(false);
				this.close();
			});

		const confirmBtn = buttonContainer.createEl("button", {
			text: "Confirm",
			cls: "mod-warning",
		});
		confirmBtn.addEventListener("click", () => {
			this.onResult(true);
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// ============================================
// Plugin
// ============================================

export default class SyncServerPlugin extends Plugin {
	settings: SyncServerSettings;
	socket: Socket | null = null;

	// Track paths being modified by server to prevent echo
	pendingPaths: Set<string> = new Set();

	async onload() {
		await this.loadSettings();

		// Connect if settings are configured
		if (this.settings.url && this.settings.apiKey) {
			this.connectSocket();
		}

		// Register vault event handlers
		this.registerEvent(
			this.app.vault.on("create", (file) => this.handleLocalCreate(file)),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => this.handleLocalModify(file)),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => this.handleLocalDelete(file)),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) =>
				this.handleLocalRename(file, oldPath),
			),
		);

		// Add settings tab
		this.addSettingTab(new SyncServerSettingTab(this.app, this));

		// Add command to manually trigger sync
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.performInitialSync(),
		});

		// Add command to reconnect
		this.addCommand({
			id: "reconnect",
			name: "Reconnect to server",
			callback: () => this.connectSocket(),
		});

		// Add command to force push local state to server
		this.addCommand({
			id: "force-push-local",
			name: "Force sync store state to local state",
			callback: () => this.forceLocalToServer(),
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

	// ============================================
	// Pending path management (prevent echo)
	// ============================================

	markPending(path: string) {
		this.pendingPaths.add(path);
	}

	clearPending(path: string) {
		// Delay removal to ensure vault events have fired
		setTimeout(() => this.pendingPaths.delete(path), 200);
	}

	isPending(path: string): boolean {
		return this.pendingPaths.has(path);
	}

	// ============================================
	// Socket connection
	// ============================================

	connectSocket() {
		// Disconnect existing socket
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
			query: {
				apiKey: this.settings.apiKey,
			},
		});

		// Connection events
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

		// Server -> Client events
		this.socket.on("file-created", (event: FileCreatedEvent) => {
			this.handleServerFileCreated(event);
		});

		this.socket.on("file-modified", (event: FileModifiedEvent) => {
			this.handleServerFileModified(event);
		});

		this.socket.on("file-deleted", (event: FileDeletedEvent) => {
			this.handleServerFileDeleted(event);
		});

		this.socket.on("file-renamed", (event: FileRenamedEvent) => {
			this.handleServerFileRenamed(event);
		});
	}

	// ============================================
	// Acknowledgment handling
	// ============================================

	handleAck(response: AckResponse, action: string) {
		if (!response.success) {
			new Notice(`Sync error: ${response.error.message}`);
			console.error(`[Sync] ${action} failed:`, response.error);
		}
	}

	// ============================================
	// Server -> Client event handlers
	// ============================================

	async handleServerFileCreated(event: FileCreatedEvent) {
		if (isBinaryFile(event.path)) return;

		console.log("[Sync] Server file created:", event.path);

		this.markPending(event.path);
		try {
			const existing = this.app.vault.getAbstractFileByPath(event.path);
			if (!existing) {
				await this.ensureParentFolder(event.path);
				await this.app.vault.create(event.path, event.content);
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
			const file = this.app.vault.getAbstractFileByPath(event.path);
			if (file instanceof TFile) {
				await this.app.vault.modify(file, event.content);
				console.log("[Sync] Modified local file:", event.path);
			} else if (!file) {
				// File doesn't exist locally, create it
				await this.ensureParentFolder(event.path);
				await this.app.vault.create(event.path, event.content);
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
			const file = this.app.vault.getAbstractFileByPath(event.path);
			if (file instanceof TFile) {
				await this.app.vault.delete(file);
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
			const file = this.app.vault.getAbstractFileByPath(event.oldPath);
			if (file instanceof TFile) {
				await this.ensureParentFolder(event.newPath);
				await this.app.vault.rename(file, event.newPath);
				console.log(
					"[Sync] Renamed local file:",
					event.oldPath,
					"->",
					event.newPath,
				);
			} else if (!file) {
				// Source doesn't exist, create at new path
				await this.ensureParentFolder(event.newPath);
				await this.app.vault.create(event.newPath, event.content);
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

	// ============================================
	// Local -> Server event handlers
	// ============================================

	async handleLocalCreate(file: TAbstractFile) {
		if (!(file instanceof TFile)) return;
		if (isBinaryFile(file.path)) return;
		if (!this.socket?.connected) return;
		if (this.isPending(file.path)) return;

		// Small delay to let content be written
		setTimeout(async () => {
			try {
				const content = await this.app.vault.read(file);
				this.socket?.emit(
					"modified-file",
					{ path: file.path, content },
					(response: AckResponse) => {
						this.handleAck(response, "Create");
					},
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
			const content = await this.app.vault.read(file);
			this.socket.emit(
				"modified-file",
				{ path: file.path, content },
				(response: AckResponse) => {
					this.handleAck(response, "Modify");
				},
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
			(response: AckResponse) => {
				this.handleAck(response, "Delete");
			},
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
			(response: AckResponse) => {
				this.handleAck(response, "Rename");
			},
		);
		console.log("[Sync] Sent rename:", oldPath, "->", file.path);
	}

	// ============================================
	// Initial sync
	// ============================================

	async performInitialSync() {
		if (!this.settings.url || !this.settings.apiKey) {
			console.log("[Sync] Cannot sync: missing settings");
			return;
		}

		console.log("[Sync] Starting initial sync...");
		new Notice("Starting sync...");

		try {
			// Fetch all files from server with pagination
			const serverFiles = new Map<string, { hash: string }>();
			let offset = 0;
			const limit = 1000;

			while (true) {
				const response = await fetch(
					`${this.settings.url}/api/v1/files?limit=${limit}&offset=${offset}`,
					{
						headers: { "X-API-Key": this.settings.apiKey },
					},
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

			console.log(`[Sync] Server has ${serverFiles.size} files`);

			// Get local files
			const localFiles = this.app.vault
				.getFiles()
				.filter((f) => !isBinaryFile(f.path));
			const localPaths = new Set(localFiles.map((f) => f.path));

			console.log(`[Sync] Local vault has ${localFiles.length} files`);

			let downloaded = 0;
			let updated = 0;
			let uploaded = 0;

			// Files on server but not locally - download them
			for (const [path] of serverFiles) {
				if (!localPaths.has(path)) {
					await this.downloadFile(path);
					downloaded++;
				}
			}

			// Files that exist both locally and on server - compare hashes
			for (const localFile of localFiles) {
				const serverInfo = serverFiles.get(localFile.path);
				if (serverInfo) {
					try {
						const content = await this.app.vault.read(localFile);
						const localHash = await computeHash(content);

						if (localHash !== serverInfo.hash) {
							// Hashes differ - server wins, download server version
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

			// Files locally but not on server - upload them
			for (const localFile of localFiles) {
				if (!serverFiles.has(localFile.path)) {
					try {
						const content = await this.app.vault.read(localFile);
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

	async downloadFile(path: string) {
		try {
			const response = await fetch(
				`${this.settings.url}/api/v1/files?path=${encodeURIComponent(path)}`,
				{
					headers: { "X-API-Key": this.settings.apiKey },
				},
			);

			if (!response.ok) {
				throw new Error(`Failed to download: ${response.status}`);
			}

			const data: FileContentResponse = await response.json();

			this.markPending(path);
			try {
				const existing = this.app.vault.getAbstractFileByPath(path);
				if (existing instanceof TFile) {
					// Update existing file
					await this.app.vault.modify(existing, data.content);
					console.log("[Sync] Updated:", path);
				} else {
					// Create new file
					await this.ensureParentFolder(path);
					await this.app.vault.create(path, data.content);
					console.log("[Sync] Downloaded:", path);
				}
			} finally {
				this.clearPending(path);
			}
		} catch (err) {
			console.error("[Sync] Failed to download:", path, err);
		}
	}

	// ============================================
	// Force push local to server
	// ============================================

	async confirmDestructiveAction(message: string): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new ConfirmModal(this.app, message, resolve);
			modal.open();
		});
	}

	async forceLocalToServer() {
		// Check settings
		if (!this.settings.url || !this.settings.apiKey) {
			new Notice("Sync server URL and API key are required");
			return;
		}

		// Confirmation dialog
		const confirmed = await this.confirmDestructiveAction(
			"This will DELETE all files on the server and replace them with your local files. This cannot be undone. Continue?",
		);
		if (!confirmed) return;

		new Notice("Force syncing local state to server...");
		console.log("[Sync] Starting force push to server...");

		try {
			// Step 1: Delete all files on server
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

			// Step 2: Upload all local files
			const localFiles = this.app.vault
				.getFiles()
				.filter((f) => !isBinaryFile(f.path));

			let uploaded = 0;
			for (const file of localFiles) {
				try {
					const content = await this.app.vault.read(file);
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

	// ============================================
	// Helpers
	// ============================================

	async ensureParentFolder(filePath: string) {
		const parts = filePath.split("/");
		parts.pop(); // Remove filename

		if (parts.length === 0) return;

		const folderPath = parts.join("/");
		const existing = this.app.vault.getAbstractFileByPath(folderPath);

		if (!existing) {
			try {
				await this.app.vault.createFolder(folderPath);
			} catch (err) {
				// Folder might already exist (race condition)
				if (!String(err).includes("Folder already exists")) {
					throw err;
				}
			}
		}
	}
}

// ============================================
// Settings Tab
// ============================================

class SyncServerSettingTab extends PluginSettingTab {
	plugin: SyncServerPlugin;

	constructor(app: App, plugin: SyncServerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Sync Server Settings" });

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("URL of your sync server (e.g., http://localhost:3006)")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:3006")
					.setValue(this.plugin.settings.url)
					.onChange(async (value) => {
						this.plugin.settings.url = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("Your store API key (starts with sk_store_)")
			.addText((text) =>
				text
					.setPlaceholder("sk_store_...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Connect")
			.setDesc("Connect to the sync server")
			.addButton((button) =>
				button.setButtonText("Connect").onClick(() => {
					this.plugin.connectSocket();
				}),
			);

		new Setting(containerEl)
			.setName("Sync Now")
			.setDesc("Manually trigger a full sync")
			.addButton((button) =>
				button.setButtonText("Sync").onClick(() => {
					this.plugin.performInitialSync();
				}),
			);
	}
}
