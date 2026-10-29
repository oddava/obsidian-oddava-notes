import { MarkdownView, Notice, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { NotesClient } from './api';
import { createDebouncer, PUBLISH_DEBOUNCE_MS, type Debouncer } from './debounce';
import { explainError, redact } from './messages';
import { createObsidianHttp } from './obsidian-http';
import {
	destinationInSyncFolder,
	folderProblem,
	hasOpenConflict,
	isSiteConflictFile,
	normalizeSyncFolder,
	normalizeVaultPath,
	pathInsideSyncFolder,
	toApiPath,
	vaultDirectory,
	vaultPathForApi,
} from './paths';
import { readUpdated } from './frontmatter';
import { mergeSettings, type OddavaSettings } from './settings-data';
import { OddavaSettingTab, type OddavaHost } from './settings';
import { buildSetupLink, parseSetupLink, SETUP_ACTION, SETUP_LINK_COPIED } from './setup-link';
import { publishNote, pullFromSite, summarizePull, testConnection } from './sync';
import type { HttpClient } from './types';
import type { LocalNote } from './sync';

export default class OddavaNotesPlugin extends Plugin implements OddavaHost {
	settings: OddavaSettings = mergeSettings(null);
	private readonly http: HttpClient = createObsidianHttp();
	private debouncer: Debouncer = createDebouncer(PUBLISH_DEBOUNCE_MS, (callback, ms) => {
		const id = window.setTimeout(callback, ms);
		return () => window.clearTimeout(id);
	});
	private readonly tails = new Map<string, Promise<void>>();
	private readonly remoteWrites = new Set<string>();
	private alive = true;
	private settingTab!: OddavaSettingTab;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addRibbonIcon('upload', 'Publish current note', () => {
			this.publishActive();
		});

		this.addCommand({
			id: 'publish-current-note',
			name: 'Publish current note',
			callback: () => {
				this.publishActive();
			},
		});

		this.addCommand({
			id: 'pull-notes-from-site',
			name: 'Pull notes from site',
			callback: () => {
				void this.pullFromSite();
			},
		});

		this.settingTab = new OddavaSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerObsidianProtocolHandler(SETUP_ACTION, (params) => {
			void this.applySetupLink(params);
		});

		this.registerEvent(this.app.vault.on('create', (file) => this.onVaultFile(file)));
		this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultFile(file)));
	}

	onunload(): void {
		this.alive = false;
		this.debouncer.cancelAll();
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async testConnection(): Promise<void> {
		await this.withClient(async (client) => {
			this.notify(await testConnection(client));
		});
	}

	async copySetupLink(): Promise<void> {
		const built = buildSetupLink({
			apiToken: this.settings.apiToken,
			baseUrl: this.settings.baseUrl,
			syncFolder: this.settings.syncFolder,
		});
		if (!built.ok || !built.link) {
			this.notify(built.ok ? 'Add the API token first, then copy the setup link.' : built.reason, 8000);
			return;
		}
		try {
			if (!navigator.clipboard?.writeText) {
				this.notify('Could not copy the setup link.', 8000);
				return;
			}
			await navigator.clipboard.writeText(built.link);
		} catch {
			this.notify('Could not copy the setup link.', 8000);
			return;
		}
		this.notify(SETUP_LINK_COPIED, 12000);
	}

	private async applySetupLink(params: Record<string, string | undefined>): Promise<void> {
		const parsed = parseSetupLink(params);
		if (!parsed.ok) {
			this.notify(parsed.reason, 8000);
			return;
		}
		this.settings.baseUrl = parsed.settings.baseUrl;
		this.settings.apiToken = parsed.settings.apiToken;
		this.settings.syncFolder = parsed.settings.syncFolder;
		await this.saveSettings();
		this.settingTab.display();
		await this.testConnection();
	}

	private publishActive(): void {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== 'md') {
			this.notify('Open a Markdown note to publish.', 6000);
			return;
		}
		this.debouncer.cancel(file.path);
		this.enqueue(file.path, () => this.publishFile(file, 'command'));
	}

	private async pullFromSite(): Promise<void> {
		if (!(await this.ensureSyncFolder())) return;
		const working = new Notice('Pulling notes from the site…', 0);
		try {
			await this.withClient(async (client) => {
				const result = await pullFromSite(client, (apiPath) => this.readLocal(apiPath));
				if (!this.alive) return;
				try {
					for (const note of result.downloaded) {
						await this.writeVaultFile(note.vaultPath, note.content);
						this.settings.synced[note.apiPath] = {
							revision: note.revision,
							fingerprint: note.fingerprint,
						};
						delete this.settings.conflictRevisions[note.apiPath];
					}
					for (const note of result.aligned) {
						this.settings.synced[note.apiPath] = {
							revision: note.revision,
							fingerprint: note.fingerprint,
						};
					}
					for (const conflict of result.conflicts) {
						await this.writeVaultFile(conflict.conflictVaultPath, conflict.remote.content);
						this.settings.conflictRevisions[conflict.apiPath] = conflict.remote.revision;
					}
				} finally {
					await this.saveSettings();
				}
				this.notify(summarizePull(result), 10000);
			});
		} finally {
			working.hide();
		}
	}

	private onVaultFile(file: TAbstractFile): void {
		if (!this.alive || !this.settings.publishOnSave) return;
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		if (this.remoteWrites.has(file.path)) return;
		if (isSiteConflictFile(file.path)) return;
		if (!toApiPath(this.settings.syncFolder, file.path).ok) return;
		this.debouncer.schedule(file.path, () => {
			this.enqueue(file.path, () => this.publishFile(file, 'autosave'));
		});
	}

	private enqueue(path: string, job: () => Promise<void>): void {
		const previous = this.tails.get(path) ?? Promise.resolve();
		const next = previous.then(job, job);
		this.tails.set(path, next);
		void next.finally(() => {
			if (this.tails.get(path) === next) this.tails.delete(path);
		});
	}

	private async publishFile(file: TFile, source: 'command' | 'autosave'): Promise<void> {
		if (!this.alive) return;
		if (isSiteConflictFile(file.path)) {
			if (source === 'command') {
				this.notify(
					'This file is a conflict copy from the site. Merge it into the original note, delete it, and publish the original.',
					8000,
				);
			}
			return;
		}

		if (!(await this.ensureSyncFolder())) return;

		if (!pathInsideSyncFolder(this.settings.syncFolder, file.path)) {
			if (source === 'command') this.offerToMove(file);
			return;
		}

		const mapped = toApiPath(this.settings.syncFolder, file.path);
		if (!mapped.ok) {
			if (source === 'command') this.notify(mapped.reason, 8000);
			return;
		}

		const siblings = this.siblingNames(file.path);
		if (
			source === 'autosave' &&
			hasOpenConflict(file.path, siblings) &&
			this.settings.conflictRevisions[mapped.apiPath]
		) {
			return;
		}

		const content = await this.readNote(file, source);
		await this.withClient(async (client) => {
			const outcome = await publishNote(client, {
				apiPath: mapped.apiPath,
				vaultPath: file.path,
				content,
				revision: this.settings.synced[mapped.apiPath]?.revision,
				pendingConflictRevision: this.settings.conflictRevisions[mapped.apiPath],
				siblingNames: siblings,
			});
			if (!this.alive) return;
			if (outcome.kind === 'blocked') {
				if (source === 'command') this.notify(outcome.message, 8000);
				return;
			}
			if (outcome.kind === 'published') {
				this.settings.synced[mapped.apiPath] = {
					revision: outcome.revision,
					fingerprint: outcome.fingerprint,
				};
				delete this.settings.conflictRevisions[mapped.apiPath];
				await this.saveSettings();
				this.notify(outcome.message);
				return;
			}
			if (outcome.kind === 'conflict') {
				await this.writeVaultFile(outcome.conflictVaultPath, outcome.remote.content);
				this.settings.conflictRevisions[mapped.apiPath] = outcome.remote.revision;
				await this.saveSettings();
				this.notify(outcome.message, 10000);
				return;
			}
			this.notify(outcome.message, 8000);
		});
	}

	private async readNote(file: TFile, source: 'command' | 'autosave'): Promise<string> {
		if (source === 'command') {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file?.path === file.path) return view.editor.getValue();
		}
		return this.app.vault.read(file);
	}

	private async readLocal(apiPath: string): Promise<LocalNote> {
		const vaultPath = vaultPathForApi(this.settings.syncFolder, apiPath);
		const record = this.settings.synced[apiPath];
		const abstract = this.app.vault.getAbstractFileByPath(vaultPath);
		const siblingNames = this.siblingNames(vaultPath);
		if (!(abstract instanceof TFile)) {
			return {
				vaultPath,
				exists: false,
				revision: record?.revision,
				fingerprint: record?.fingerprint,
				siblingNames,
			};
		}
		const content = await this.app.vault.read(abstract);
		return {
			vaultPath,
			exists: true,
			content,
			updated: readUpdated(content),
			revision: record?.revision,
			fingerprint: record?.fingerprint,
			siblingNames,
		};
	}

	private siblingNames(vaultPath: string): string[] {
		const directory = vaultDirectory(vaultPath);
		const parent = directory
			? this.app.vault.getAbstractFileByPath(directory)
			: this.app.vault.getRoot();
		if (!(parent instanceof TFolder)) return [];
		return parent.children
			.filter((child): child is TFile => child instanceof TFile)
			.map((child) => child.name);
	}

	private async writeVaultFile(vaultPath: string, content: string): Promise<void> {
		this.assertInsideSyncFolder(vaultPath);
		this.debouncer.cancel(vaultPath);
		this.remoteWrites.add(vaultPath);
		try {
			const existing = this.app.vault.getAbstractFileByPath(vaultPath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, content);
				return;
			}
			if (existing) {
				throw new Error(`${vaultPath} is not a note, so it was left alone.`);
			}
			await this.ensureFolder(vaultPath);
			await this.app.vault.create(vaultPath, content);
		} finally {
			window.setTimeout(() => {
				this.remoteWrites.delete(vaultPath);
			}, 1000);
		}
	}

	private offerToMove(file: TFile): void {
		const folder = normalizeSyncFolder(this.settings.syncFolder);
		const destination = destinationInSyncFolder(folder, file.path);
		if (!destination) {
			this.notify(`This note is outside the sync folder "${folder}".`, 8000);
			return;
		}
		const mapped = toApiPath(folder, destination);
		if (!mapped.ok) {
			this.notify(`This note is outside "${folder}". ${mapped.reason}`, 10000);
			return;
		}
		if (this.app.vault.getAbstractFileByPath(destination)) {
			this.notify(`"${destination}" already exists, so "${file.path}" was left where it is.`, 8000);
			return;
		}

		const fragment = document.createDocumentFragment();
		const wrap = fragment.createDiv({ cls: 'oddava-notes-move-notice' });
		wrap.createEl('div', {
			text: `"${file.path}" is outside the sync folder. Move it to "${destination}" and publish?`,
		});
		const button = wrap.createEl('button', { text: 'Move and publish' });
		const notice = new Notice(fragment, 20000);
		button.addEventListener('click', () => {
			notice.hide();
			if (!this.alive) return;
			void this.moveAndPublish(file, destination);
		});
	}

	private async moveAndPublish(file: TFile, destination: string): Promise<void> {
		this.debouncer.cancel(file.path);
		this.remoteWrites.add(file.path);
		this.remoteWrites.add(destination);
		try {
			await this.ensureFolder(destination);
			await this.app.fileManager.renameFile(file, destination);
		} catch (error) {
			this.notify(explainError(error), 8000);
			return;
		} finally {
			window.setTimeout(() => {
				this.remoteWrites.delete(file.path);
				this.remoteWrites.delete(destination);
			}, 1000);
		}
		const moved = this.app.vault.getAbstractFileByPath(destination);
		if (!(moved instanceof TFile)) {
			this.notify('The note was moved, but it could not be published.', 8000);
			return;
		}
		await this.publishFile(moved, 'command');
	}

	private async ensureSyncFolder(): Promise<boolean> {
		const folder = normalizeSyncFolder(this.settings.syncFolder);
		const problem = folderProblem(this.settings.syncFolder);
		if (problem || !folder) {
			this.notify(problem ?? 'Set a vault folder to sync.', 8000);
			return false;
		}
		try {
			await this.ensureFolder(`${folder}/note.md`);
			return true;
		} catch (error) {
			this.notify(explainError(error), 8000);
			return false;
		}
	}

	private assertInsideSyncFolder(vaultPath: string): void {
		const folder = normalizeSyncFolder(this.settings.syncFolder);
		const path = normalizeVaultPath(vaultPath);
		const inside = path === folder || path.startsWith(`${folder}/`);
		if (!folder || !inside || path.split('/').includes('..')) {
			throw new Error('Refusing to write outside the sync folder.');
		}
	}

	private async ensureFolder(filePath: string): Promise<void> {
		const slash = filePath.lastIndexOf('/');
		if (slash <= 0) return;
		const parts = filePath.slice(0, slash).split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`${current} is not a folder.`);
			try {
				await this.app.vault.createFolder(current);
			} catch (error) {
				const again = this.app.vault.getAbstractFileByPath(current);
				if (!(again instanceof TFolder)) throw error;
			}
		}
	}

	private async withClient(run: (client: NotesClient) => Promise<void>): Promise<void> {
		let client: NotesClient;
		try {
			client = new NotesClient(this.http, this.settings.baseUrl, this.settings.apiToken);
		} catch (error) {
			this.notify(explainError(error), 8000);
			return;
		}
		try {
			await run(client);
		} catch (error) {
			this.notify(explainError(error), 8000);
		}
	}

	private notify(message: string, timeout = 5000): void {
		if (!this.alive) return;
		new Notice(redact(message, this.settings.apiToken), timeout);
	}
}
