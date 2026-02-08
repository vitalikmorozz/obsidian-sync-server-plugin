import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";
import { Socket, io } from "socket.io-client";

interface SyncServerSettings {
	url: string;
	apiKey: string;
	extensionsBlacklist: string[];
}

const DEFAULT_SETTINGS: SyncServerSettings = {
	url: "",
	apiKey: "",
	extensionsBlacklist: [],
};

let socket: Socket;

const connectSocket = (settings: SyncServerSettings) => {
	if (socket?.connected) socket.disconnect();

	socket = io(settings.url, {
		// https://socket.io/docs/v4/client-options
		reconnectionAttempts: 3,
		reconnectionDelay: 5000,
		reconnectionDelayMax: 30000,
		retries: 3,
		transports: ["websocket"],
		query: {
			apiKey: settings.apiKey,
		},
	});
	socket.on("connect", () => {
		new Notice("Connected to the server!");
	});
};

export default class SyncServer extends Plugin {
	settings: SyncServerSettings;

	async onload() {
		await this.loadSettings();

		connectSocket(this.settings);

		this.addCommand({
			id: "get-all-vault-files",
			name: "Get all Vault files",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const files = this.app.vault.getFiles();
				console.log(files);
			},
		});

		// No point of creation of empty files, additionally, they all will have an incorrect name
		this.app.vault.on("create", (file) => {
			// if (!socket.connected) return;
			// socket.emit("created-file", {
			// 	filename: file.name,
			// 	path: file.path,
			// });
			// console.log("New file created", file);
		});

		this.app.vault.on("delete", (file) => {
			if (!socket.connected) return;

			socket.emit("deleted-file", {
				path: file.path,
			});

			console.log("File deleted", file);
		});

		this.app.vault.on("modify", async (file) => {
			if (!socket.connected) return;

			const content = await file.vault.adapter.read(file.path);

			socket.emit("modified-file", {
				path: file.path,
				content,
			});

			console.log("File modified", file);
		});

		this.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) {
				// Skip if folder
				return;
			}

			if (!socket.connected) return;

			socket.emit("renamed-file", {
				newPath: file.path,
				oldPath,
			});

			console.log("File renamed", file, oldPath);
		});

		this.addSettingTab(new SyncServerSettingTab(this.app, this));
	}

	onunload() {
		if (socket.connected) socket.disconnect();
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
}

class SyncServerSettingTab extends PluginSettingTab {
	plugin: SyncServer;

	constructor(app: App, plugin: SyncServer) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("URL of your sync server")
			.addText((text) =>
				text
					.setPlaceholder("https://localhost:3333")
					.setValue(this.plugin.settings.url)
					.onChange(async (value) => {
						// TODO: Validate
						this.plugin.settings.url = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("API Key to your sync server")
			.addText((text) =>
				text
					.setPlaceholder("cw8m07g3h04cd4gcn4")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						// TODO: Validate
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Connect")
			.setDesc("Connect to the server")
			.addButton((button) =>
				button.setButtonText("Connect").onClick(() => {
					connectSocket(this.plugin.settings);
				}),
			);

		new Setting(containerEl)
			.setName("Extensions blacklist")
			.setDesc(
				"List of comma separated extensions to ignore while synchronizing",
			)
			.addText((text) =>
				text
					.setPlaceholder("xls,word,csv,...")
					.setValue(
						this.plugin.settings.extensionsBlacklist.join(","),
					)
					.onChange(async (value) => {
						// TODO: Validate
						this.plugin.settings.extensionsBlacklist =
							value.split(",");
						await this.plugin.saveSettings();
					}),
			);
	}
}
