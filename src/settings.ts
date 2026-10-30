import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { normalizeSyncFolder } from './paths';
import {
	clampAutoPullMinutes,
	defaultSettings,
	MIN_AUTO_PULL_MINUTES,
	type OddavaSettings,
} from './settings-data';
import { DEFAULT_TELEGRAM_CHANNEL, normalizeTelegramChannel } from './telegram';
import { siteDeleteSetting } from './vault-sync';

export interface OddavaHost {
	settings: OddavaSettings;
	saveSettings(): Promise<void>;
	testConnection(): Promise<void>;
	copySetupLink(): Promise<void>;
	refreshAutoPull(): void;
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
			.setName('When a note is deleted')
			.setDesc(
				'A synced note removed from the vault, or moved out of the sync folder. Deleting on the site moves it to the trash. It can be restored.',
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption('ask', 'Ask')
					.addOption('always', 'Always delete on the site')
					.addOption('never', 'Keep on the site')
					.setValue(this.plugin.settings.siteDelete)
					.onChange(async (value) => {
						this.plugin.settings.siteDelete = siteDeleteSetting(value);
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
			.setName('Pull automatically')
			.setDesc(
				'While Obsidian is open, pull notes from the site a few seconds after the workspace is ready, then on the interval below. Unpublished local edits are left alone, the same as Pull notes from site.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoPull).onChange(async (value) => {
					this.plugin.settings.autoPull = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAutoPull();
				}),
			);

		new Setting(containerEl)
			.setName('Auto-pull interval')
			.setDesc(
				`Minutes between automatic pulls. At least ${MIN_AUTO_PULL_MINUTES}. The site allows 120 requests a minute; each pull is one list plus a fetch for every note that changed.`,
			)
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = String(MIN_AUTO_PULL_MINUTES);
				text.inputEl.step = '1';
				text.inputEl.inputMode = 'numeric';
				text.setValue(String(this.plugin.settings.autoPullIntervalMinutes));
				text.onChange(async (value) => {
					const minutes = wholeMinutes(value);
					if (minutes === null || minutes === this.plugin.settings.autoPullIntervalMinutes) return;
					this.plugin.settings.autoPullIntervalMinutes = minutes;
					await this.plugin.saveSettings();
					this.plugin.refreshAutoPull();
				});
				text.inputEl.addEventListener('blur', () => {
					const minutes = clampAutoPullMinutes(text.getValue());
					text.setValue(String(minutes));
					if (minutes === this.plugin.settings.autoPullIntervalMinutes) return;
					this.plugin.settings.autoPullIntervalMinutes = minutes;
					void this.plugin.saveSettings().then(() => {
						this.plugin.refreshAutoPull();
					});
				});
			});

		let botInput: HTMLInputElement | null = null;
		new Setting(containerEl)
			.setName('Telegram bot token')
			.setDesc(
				'From @BotFather. The bot must be an admin of the channel. It stays in this plugin’s data on the device. Notices never include it. Posts are not sent on their own unless a note says telegram: true.',
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
				text.inputEl.autocapitalize = 'off';
				text.inputEl.spellcheck = false;
				text.setPlaceholder('Paste the bot token');
				text.setValue(this.plugin.settings.telegramBotToken);
				botInput = text.inputEl;
				text.onChange(async (value) => {
					const trimmed = value.trim();
					if (trimmed !== value) text.setValue(trimmed);
					this.plugin.settings.telegramBotToken = trimmed;
					await this.plugin.saveSettings();
				});
			})
			.addButton((button) =>
				button.setButtonText('Show').onClick(() => {
					if (!botInput) return;
					const hidden = botInput.type === 'password';
					botInput.type = hidden ? 'text' : 'password';
					button.setButtonText(hidden ? 'Hide' : 'Show');
				}),
			);

		new Setting(containerEl)
			.setName('Telegram channel')
			.setDesc(
				'Where posts go. A public channel like @justoddava, or a numeric id. The bot has to be an admin there.',
			)
			.addText((text) => {
				text.setPlaceholder(DEFAULT_TELEGRAM_CHANNEL).setValue(this.plugin.settings.telegramChannel);
				text.onChange(async (value) => {
					const normalized = normalizeTelegramChannel(value);
					if (!normalized || normalized === this.plugin.settings.telegramChannel) return;
					this.plugin.settings.telegramChannel = normalized;
					await this.plugin.saveSettings();
				});
				text.inputEl.addEventListener('blur', () => {
					const normalized =
						normalizeTelegramChannel(text.getValue()) ||
						this.plugin.settings.telegramChannel ||
						DEFAULT_TELEGRAM_CHANNEL;
					text.setValue(normalized);
					if (normalized === this.plugin.settings.telegramChannel) return;
					this.plugin.settings.telegramChannel = normalized;
					void this.plugin.saveSettings();
				});
			});

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

/** Accept a finished whole number of minutes. Leave partial typing for blur. */
function wholeMinutes(value: string): number | null {
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	const minutes = clampAutoPullMinutes(parsed);
	if (minutes !== parsed) return null;
	return minutes;
}
