import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { normalizeSyncFolder } from './paths';
import { defaultSettings, type OddavaSettings } from './settings-data';

export interface OddavaHost {
	settings: OddavaSettings;
	saveSettings(): Promise<void>;
	testConnection(): Promise<void>;
	copySetupLink(): Promise<void>;
}

export class OddavaSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: Plugin & OddavaHost,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('oddava-notes-settings');

		new Setting(containerEl)
			.setName('Site URL')
			.setDesc('Origin of the notes API. No path. The default is the public site.')
			.addText((text) =>
				text
					.setPlaceholder('https://oddava.me')
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		let tokenInput: HTMLInputElement | null = null;
		new Setting(containerEl)
			.setName('API token')
			.setDesc(
				'Bearer token for NOTES_API_TOKEN. It stays in this plugin’s data on the device. Notices and the console never include it.',
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
				text.inputEl.autocapitalize = 'off';
				text.inputEl.spellcheck = false;
				text.setPlaceholder('Paste the token');
				text.setValue(this.plugin.settings.apiToken);
				tokenInput = text.inputEl;
				text.onChange(async (value) => {
					const trimmed = value.trim();
					if (trimmed !== value) text.setValue(trimmed);
					this.plugin.settings.apiToken = trimmed;
					await this.plugin.saveSettings();
				});
			})
			.addButton((button) =>
				button.setButtonText('Show').onClick(() => {
					if (!tokenInput) return;
					const hidden = tokenInput.type === 'password';
					tokenInput.type = hidden ? 'text' : 'password';
					button.setButtonText(hidden ? 'Hide' : 'Show');
				}),
			);

		new Setting(containerEl)
			.setName('Vault folder')
			.setDesc(
				'Notes inside this folder sync. oddava.me/diary/hello.md is published as diary/hello.md. Use lowercase kebab-case for every folder and file under it.',
			)
			.addText((text) => {
				text.setPlaceholder('oddava.me').setValue(this.plugin.settings.syncFolder);
				// Normalize on blur so a trailing slash can be typed.
				// Stripping it on every keystroke turns `notes/` into `notes` before the next segment.
				text.inputEl.addEventListener('blur', () => {
					const normalized =
						normalizeSyncFolder(text.getValue()) || defaultSettings().syncFolder;
					text.setValue(normalized);
					this.plugin.settings.syncFolder = normalized;
					void this.plugin.saveSettings();
				});
				text.onChange(async (value) => {
					this.plugin.settings.syncFolder = value.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Publish on save')
			.setDesc(
				'After a note in the sync folder is saved, wait a moment and publish it. Off until you turn it on.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.publishOnSave).onChange(async (value) => {
					this.plugin.settings.publishOnSave = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Another device')
			.setDesc(
				'Copies a link with your token, site URL, and folder. Open it on your phone or other computer. Send it only to yourself.',
			)
			.addButton((button) =>
				button.setButtonText('Copy setup link for another device').onClick(() => {
					void this.plugin.copySetupLink();
				}),
			);

		new Setting(containerEl)
			.setName('Connection')
			.setDesc('Lists notes on the site. It does not upload or download anything.')
			.addButton((button) =>
				button.setButtonText('Test connection').onClick(() => {
					button.setDisabled(true);
					button.setButtonText('Testing…');
					void this.plugin.testConnection().finally(() => {
						button.setDisabled(false);
						button.setButtonText('Test connection');
					});
				}),
			);
	}
}
