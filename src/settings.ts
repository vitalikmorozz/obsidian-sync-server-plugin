import { App, PluginSettingTab, Setting } from "obsidian";
import type SyncServerPlugin from "./plugin";

export class SyncServerSettingTab extends PluginSettingTab {
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
