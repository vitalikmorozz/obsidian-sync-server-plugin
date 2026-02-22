import { Notice, Vault } from "obsidian";
import type {
	SyncServerSettings,
	SettingsListResponse,
	SettingsContentResponse,
} from "./types";
import { checkContentSize } from "./utils";

/** Paths excluded from settings sync (relative to .obsidian/) */
const EXCLUDED_PATHS = ["workspace.json", "workspace-mobile.json"];

/** Path prefixes excluded from settings sync (relative to .obsidian/) */
const EXCLUDED_PREFIXES = ["plugins/sync-server/"];

/** Only these filenames are allowed inside plugin directories (plugins/<name>/) */
const ALLOWED_PLUGIN_FILES = new Set([
	"main.js",
	"manifest.json",
	"styles.css",
	"data.json",
]);

export class SettingsSyncService {
	private vault: Vault;
	private settings: SyncServerSettings;

	constructor(vault: Vault, settings: SyncServerSettings) {
		this.vault = vault;
		this.settings = settings;
	}

	/**
	 * Check if a path (relative to .obsidian/) should be excluded from sync.
	 *
	 * Exclusion rules:
	 * 1. Specific paths (workspace.json, workspace-mobile.json)
	 * 2. The sync-server plugin's own files
	 * 3. Any path segment starting with "." (dotfiles like .DS_Store, .gitignore)
	 * 4. Any path containing "node_modules" as a segment
	 * 5. Plugin files: only main.js, manifest.json, styles.css, data.json are allowed
	 */
	private isExcluded(path: string): boolean {
		if (EXCLUDED_PATHS.includes(path)) return true;
		if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)))
			return true;

		const segments = path.split("/");

		// Block any path where a segment starts with "." (dotfiles/dotfolders)
		if (segments.some((s) => s.startsWith("."))) return true;

		// Block any path containing node_modules
		if (segments.includes("node_modules")) return true;

		// For files inside plugins/<name>/, only allow the four permitted filenames
		if (
			segments[0] === "plugins" &&
			segments.length >= 3 // plugins/<name>/<file>
		) {
			const filename = segments[segments.length - 1];
			// Only allow top-level plugin files (plugins/<name>/<file>), not nested ones
			if (segments.length > 3 || !ALLOWED_PLUGIN_FILES.has(filename))
				return true;
		}

		return false;
	}

	/**
	 * Recursively collect all files under .obsidian/ using the vault adapter.
	 * Returns paths relative to .obsidian/ with their content.
	 */
	private async collectLocalSettings(): Promise<
		Array<{ path: string; content: string }>
	> {
		const results: Array<{ path: string; content: string }> = [];
		const adapter = this.vault.adapter;

		const walk = async (dir: string) => {
			const listing = await adapter.list(dir);

			for (const filePath of listing.files) {
				// Convert absolute vault path to relative .obsidian/ path
				const relativePath = filePath.startsWith(".obsidian/")
					? filePath.slice(".obsidian/".length)
					: filePath;

				if (this.isExcluded(relativePath)) continue;

				try {
					const content = await adapter.read(filePath);
					results.push({ path: relativePath, content });
				} catch (err) {
					console.error(
						"[SettingsSync] Failed to read:",
						filePath,
						err,
					);
				}
			}

			for (const folder of listing.folders) {
				await walk(folder);
			}
		};

		await walk(".obsidian");
		return results;
	}

	/**
	 * Push all local .obsidian/ settings to the server.
	 * Deletes all server settings first, then uploads each file.
	 */
	async pushSettings(): Promise<void> {
		if (!this.settings.url || !this.settings.apiKey) {
			new Notice("Sync server URL and API key are required");
			return;
		}

		new Notice("Pushing vault settings to server...");
		console.log("[SettingsSync] Starting push...");

		try {
			// Delete all existing settings on server
			const deleteResponse = await fetch(
				`${this.settings.url}/api/v1/settings/all`,
				{
					method: "DELETE",
					headers: { "X-API-Key": this.settings.apiKey },
				},
			);

			if (!deleteResponse.ok) {
				throw new Error(
					`Failed to clear server settings: ${deleteResponse.status}`,
				);
			}

			const { deleted } = await deleteResponse.json();
			console.log(
				`[SettingsSync] Deleted ${deleted} settings from server`,
			);

			// Collect and upload local settings
			const localSettings = await this.collectLocalSettings();
			let uploaded = 0;
			let skipped = 0;

			for (const setting of localSettings) {
				const sizeError = checkContentSize(
					setting.content,
					setting.path,
				);
				if (sizeError) {
					console.warn("[SettingsSync] Skipped:", sizeError);
					skipped++;
					continue;
				}

				try {
					const response = await fetch(
						`${this.settings.url}/api/v1/settings`,
						{
							method: "PUT",
							headers: {
								"Content-Type": "application/json",
								"X-API-Key": this.settings.apiKey,
							},
							body: JSON.stringify({
								path: setting.path,
								content: setting.content,
							}),
						},
					);

					if (!response.ok) {
						console.error(
							`[SettingsSync] Failed to upload ${setting.path}: ${response.status}`,
						);
					} else {
						uploaded++;
					}
				} catch (err) {
					console.error(
						`[SettingsSync] Failed to upload ${setting.path}:`,
						err,
					);
				}
			}

			console.log(
				`[SettingsSync] Push complete: ${uploaded}/${localSettings.length} uploaded, ${skipped} skipped`,
			);
			let msg = `Settings push complete: ${uploaded} files uploaded to server`;
			if (skipped > 0) {
				msg += `, ${skipped} skipped (too large)`;
			}
			new Notice(msg);
		} catch (err) {
			console.error("[SettingsSync] Push failed:", err);
			new Notice("Settings push failed. Check console for details.");
		}
	}

	/**
	 * Pull all settings from the server and write to local .obsidian/.
	 * Downloads each file's content and writes it locally.
	 * Deletes local-only non-excluded files that aren't on the server.
	 */
	async pullSettings(): Promise<void> {
		if (!this.settings.url || !this.settings.apiKey) {
			new Notice("Sync server URL and API key are required");
			return;
		}

		new Notice("Pulling vault settings from server...");
		console.log("[SettingsSync] Starting pull...");

		try {
			// Fetch settings list from server
			const listResponse = await fetch(
				`${this.settings.url}/api/v1/settings`,
				{
					headers: { "X-API-Key": this.settings.apiKey },
				},
			);

			if (!listResponse.ok) {
				throw new Error(
					`Failed to fetch settings list: ${listResponse.status}`,
				);
			}

			const listData: SettingsListResponse = await listResponse.json();
			console.log(`[SettingsSync] Server has ${listData.total} settings`);

			const serverPaths = new Set<string>();
			let written = 0;

			// Download and write each setting
			for (const setting of listData.settings) {
				serverPaths.add(setting.path);

				try {
					const contentResponse = await fetch(
						`${this.settings.url}/api/v1/settings?path=${encodeURIComponent(setting.path)}`,
						{
							headers: {
								"X-API-Key": this.settings.apiKey,
							},
						},
					);

					if (!contentResponse.ok) {
						console.error(
							`[SettingsSync] Failed to download ${setting.path}: ${contentResponse.status}`,
						);
						continue;
					}

					const data: SettingsContentResponse =
						await contentResponse.json();

					const localPath = `.obsidian/${data.path}`;

					// Ensure parent folder exists
					await this.ensureParentFolder(localPath);

					// Write the file
					await this.vault.adapter.write(localPath, data.content);
					written++;
				} catch (err) {
					console.error(
						`[SettingsSync] Failed to download ${setting.path}:`,
						err,
					);
				}
			}

			// Delete local-only files that aren't on the server
			const localSettings = await this.collectLocalSettings();
			let deletedCount = 0;

			for (const local of localSettings) {
				if (!serverPaths.has(local.path)) {
					try {
						const localPath = `.obsidian/${local.path}`;
						await this.vault.adapter.remove(localPath);
						console.log(
							"[SettingsSync] Deleted local-only:",
							local.path,
						);
						deletedCount++;
					} catch (err) {
						console.error(
							`[SettingsSync] Failed to delete ${local.path}:`,
							err,
						);
					}
				}
			}

			console.log(
				`[SettingsSync] Pull complete: ${written} written, ${deletedCount} local-only deleted`,
			);
			new Notice(
				`Settings pull complete: ${written} files written, ${deletedCount} deleted. Restart Obsidian to apply changes.`,
			);
		} catch (err) {
			console.error("[SettingsSync] Pull failed:", err);
			new Notice("Settings pull failed. Check console for details.");
		}
	}

	/**
	 * Ensure parent folders exist for a given file path.
	 */
	private async ensureParentFolder(filePath: string): Promise<void> {
		const parts = filePath.split("/");
		parts.pop();

		if (parts.length === 0) return;

		const folderPath = parts.join("/");
		const exists = await this.vault.adapter.exists(folderPath);

		if (!exists) {
			// Create folders recursively
			await this.vault.adapter.mkdir(folderPath);
		}
	}
}
