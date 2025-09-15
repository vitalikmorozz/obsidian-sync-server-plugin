import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as fs from 'node:fs';
import * as path from "node:path";

interface SyncServerSettings {
	url: string;
	apiKey: string;
	extensionsBlacklist: string[];
}

const DEFAULT_SETTINGS: SyncServerSettings = {
	url: "",
	apiKey: "",
	extensionsBlacklist: [],
}

export default class SyncServer extends Plugin {
	settings: SyncServerSettings;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		this.addCommand({
			id: "get-all-vault-files",
			name: "Get all Vault files",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const files = this.app.vault.getFiles();
				console.log(files);
			}
		})

		this.app.vault.on("create", (file) => {
			console.log("New file created", file);
		});

		this.app.vault.on("delete", (file) => {
			console.log("File deleted", file);
		});

		this.app.vault.on("modify", async (file) => {
			console.log("File modified", file);
			const contents = await file.vault.adapter.read(file.path);
			// const fullPath = path.join();
			console.log(contents);
		});

		this.app.vault.on("rename", (file) => {
			console.log("File renamed", file);
		});

		this.addSettingTab(new SyncServerSettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
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
			.setName('Server URL')
			.setDesc("URL of your sync server")
			.addText((text) =>
				text
					.setPlaceholder('https://localhost:3333')
					.setValue(this.plugin.settings.url)
					.onChange(async (value) => {
						// TODO: Validate
						this.plugin.settings.url = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc("API Key to your sync server")
			.addText((text) =>
				text
					.setPlaceholder('cw8m07g3h04cd4gcn4')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						// TODO: Validate
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Extensions blacklist')
			.setDesc("List of comma separated extensions to ignore while synchronizing")
			.addText((text) =>
				text
					.setPlaceholder('xls,word,csv,...')
					.setValue(this.plugin.settings.extensionsBlacklist.join(","))
					.onChange(async (value) => {
						// TODO: Validate
						this.plugin.settings.extensionsBlacklist = value.split(",");
						await this.plugin.saveSettings();
					})
			);
	}
}
