import { MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { NotesClient } from './api';
import {
	canAutoPull,
	createAutoPullSchedule,
	createPullGate,
	noticeForAutoPull,
	quietAutoPullNotice,
	type AutoPullNotice,
	type AutoPullSchedule,
	type PullSource,
} from './auto-pull';
import { createDebouncer, PUBLISH_DEBOUNCE_MS, type Debouncer } from './debounce';
import { NotesApiError } from './errors';
import { explainError, redact } from './messages';
import { createObsidianHttp } from './obsidian-http';
import {
	destinationInSyncFolder,
	folderProblem,
	hasOpenConflict,
	isSiteConflictFile,
	nextConflictVaultPath,
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
import {
	findRemoteMoves,
	publishNote,
	pullFromSite,
	summarizePull,
	testConnection,
	type PullResult,
	type RemoteMove,
} from './sync';
import { SiteDeleteModal } from './site-delete-modal';
import { TelegramPostModal } from './telegram-modal';
import {
	editTelegramMessage,
	prepareTelegramPost,
	sendTelegramMessage,
	telegramFollowUp,
	telegramHtml,
	telegramTokenProblem,
	TelegramPostDeleted,
	withTelegramMessageId,
	type TelegramPostDraft,
} from './telegram';
import { contentFingerprint } from './fingerprint';
import { preserveTelegramFrontmatter, readTelegramFrontmatter } from './frontmatter';
import {
	bulkDeletePrompt,
	canonicalApiPath,
	createMoveChain,
	leftFolderPrompt,
	planDeleteBatch,
	planRestore,
	planVaultRename,
	siteDeletePrompt,
} from './vault-sync';
import type { HttpClient } from './types';
import type { LocalNote } from './sync';

export default class OddavaNotesPlugin extends Plugin implements OddavaHost {
	settings: OddavaSettings = mergeSettings(null);
	private readonly http: HttpClient = createObsidianHttp();
	private debouncer: Debouncer = createDebouncer(PUBLISH_DEBOUNCE_MS, (callback, ms) => {
		const id = window.setTimeout(callback, ms);
		return () => window.clearTimeout(id);
	});
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly remoteWrites = new Set<string>();
	private readonly telegramSending = new Set<string>();
	private readonly pendingSiteDeletes = new Set<string>();
	private readonly moveChain = createMoveChain();
	private readonly siteDeleteQueue: {
		apiPath: string;
		revision: string;
		kind: 'deleted' | 'left-folder';
	}[] = [];
	private siteDeleteFlush: number | null = null;
	/** Rename and delete are ignored until the workspace layout is ready. */
	private vaultReady = false;
	private readonly pulls = createPullGate();
	private readonly autoPull: AutoPullSchedule = createAutoPullSchedule({
		enabled: () => this.alive && this.settings.autoPull,
		intervalMinutes: () => this.settings.autoPullIntervalMinutes,
		pull: () => {
			if (!this.alive) return;
			void this.pullFromSite('auto');
		},
		timers: {
			setTimeout: (callback, ms) => {
				const id = window.setTimeout(callback, ms);
				return { cancel: () => window.clearTimeout(id) };
			},
			setInterval: (callback, ms) => {
				const id = window.setInterval(callback, ms);
				this.registerInterval(id);
				return { cancel: () => window.clearInterval(id) };
			},
		},
	});
	/** Last automatic-pull failure that was announced. Same text stays quiet. */
	private lastAutoPullError: string | null = null;
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
				void this.pullFromSite('manual');
			},
		});

		this.addCommand({
			id: 'post-current-note-to-telegram',
			name: 'Post current note to Telegram',
			callback: () => {
				void this.postActiveToTelegram();
			},
		});

		this.addCommand({
			id: 'publish-and-post-to-telegram',
			name: 'Publish and post to Telegram',
			callback: () => {
				this.publishAndPostActive();
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && file.extension === 'md') this.addTelegramMenuItem(menu, file);
			}),
		);
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, _editor, view) => {
				const file = view.file;
				if (file instanceof TFile && file.extension === 'md') this.addTelegramMenuItem(menu, file);
			}),
		);

		this.settingTab = new OddavaSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerObsidianProtocolHandler(SETUP_ACTION, (params) => {
			void this.applySetupLink(params);
		});

		this.registerEvent(this.app.vault.on('create', (file) => this.onVaultFile(file)));
		this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultFile(file)));

		// Vault indexing can emit rename and delete before the layout is ready.
		// Those are not the user moving or deleting a note.
		this.app.workspace.onLayoutReady(() => {
			if (!this.alive) return;
			this.vaultReady = true;
			this.registerEvent(
				this.app.vault.on('rename', (file, oldPath) => {
					void this.onVaultRename(file, oldPath);
				}),
			);
			this.registerEvent(
				this.app.vault.on('delete', (file) => {
					void this.onVaultDelete(file);
				}),
			);
			this.autoPull.arm();
		});
	}

	onunload(): void {
		this.alive = false;
		this.vaultReady = false;
		if (this.siteDeleteFlush !== null) window.clearTimeout(this.siteDeleteFlush);
		this.autoPull.stop();
		this.debouncer.cancelAll();
	}

	refreshAutoPull(): void {
		this.autoPull.reconfigure();
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

	private publishAndPostActive(): void {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== 'md') {
			this.notify('Open a Markdown note to publish.', 6000);
			return;
		}
		this.debouncer.cancel(file.path);
		this.enqueue(file.path, async () => {
			const content = await this.readNote(file, 'publish-and-post');
			const result = await this.publishFile(file, 'publish-and-post');
			if (result === 'published') await this.openTelegramPost(file, content);
		});
	}

	private addTelegramMenuItem(menu: Menu, file: TFile): void {
		menu.addItem((item) => {
			item.setTitle('Post to Telegram').setIcon('send').onClick(() => {
				void this.postFileToTelegram(file);
			});
		});
	}

	private async pullFromSite(source: PullSource): Promise<void> {
		if (!this.alive) return;
		const working = source === 'manual' ? new Notice('Pulling notes from the site…', 0) : null;
		try {
			await this.pulls.run(source, () => this.executePull(source));
		} finally {
			working?.hide();
		}
	}

	/**
	 * Manual and automatic pulls share this path, including conflict copies.
	 * A manual pull always summarizes. An automatic pull stays quiet unless
	 * notes were downloaded, a conflict file was written, or a new error appeared.
	 */
	private async executePull(source: PullSource): Promise<void> {
		if (!this.alive) return;
		if (source === 'auto' && !canAutoPull(this.settings)) return;
		if (!(await this.ensureSyncFolder(source))) return;
		await this.withClient(
			async (client) => {
				const garden = await client.listGarden();
				const livePaths = garden.notes
					.map((note) => canonicalApiPath(note.path))
					.filter((path): path is string => path !== null);
				const deletedPaths = garden.deleted
					.map((note) => canonicalApiPath(note.path))
					.filter((path): path is string => path !== null);
				const recon = await findRemoteMoves(
					client,
					Object.keys(this.settings.synced),
					livePaths,
					deletedPaths,
				);
				const saved = { dirty: false };
				const cleared: string[] = [];
				for (const move of recon.moves) {
					if (await this.applyRemoteMove(move)) {
						saved.dirty = true;
						this.notify(
							`The site moved ${move.fromApiPath} to ${move.toApiPath}. The vault note followed it.`,
						);
					}
				}
				for (const apiPath of recon.gone) {
					if (!this.settings.synced[apiPath]) continue;
					delete this.settings.synced[apiPath];
					cleared.push(apiPath);
					saved.dirty = true;
				}
				const result = await pullFromSite(client, (apiPath) => this.readLocal(apiPath), garden);
				result.trashed = cleared;
				if (recon.stoppedEarly && !result.stoppedEarly) result.stoppedEarly = recon.stoppedEarly;
				if (!this.alive) return;
				try {
					await this.applyPull(result, saved);
				} finally {
					if (saved.dirty) await this.saveSettings();
				}
				if (!this.alive) return;
				if (source === 'manual') {
					this.lastAutoPullError = result.stoppedEarly?.trim() ? result.stoppedEarly : null;
					this.notify(summarizePull(result), 10000);
					return;
				}
				this.reportAutoPull(noticeForAutoPull(this.lastAutoPullError, result));
			},
			(message) => {
				if (source === 'auto') {
					this.reportAutoFailure(message);
					return;
				}
				this.lastAutoPullError = message;
				this.notify(message, 8000);
			},
		);
	}

	private async applyPull(result: PullResult, saved: { dirty: boolean }): Promise<void> {
		for (const note of result.downloaded) {
			const content = await this.withLocalTelegramFields(note.vaultPath, note.content);
			await this.writeVaultFile(note.vaultPath, content);
			this.settings.synced[note.apiPath] = {
				revision: note.revision,
				fingerprint: contentFingerprint(content),
			};
			delete this.settings.conflictRevisions[note.apiPath];
			saved.dirty = true;
		}
		for (const note of result.aligned) {
			const current = this.settings.synced[note.apiPath];
			if (current?.revision === note.revision && current.fingerprint === note.fingerprint) continue;
			this.settings.synced[note.apiPath] = {
				revision: note.revision,
				fingerprint: note.fingerprint,
			};
			saved.dirty = true;
		}
		for (const conflict of result.conflicts) {
			await this.writeVaultFile(conflict.conflictVaultPath, conflict.remote.content);
			this.settings.conflictRevisions[conflict.apiPath] = conflict.remote.revision;
			saved.dirty = true;
		}
	}

	private reportAutoFailure(message: string): void {
		this.reportAutoPull(
			quietAutoPullNotice(this.lastAutoPullError, { changed: null, error: message }),
		);
	}

	private reportAutoPull(feedback: AutoPullNotice): void {
		this.lastAutoPullError = feedback.remember;
		if (feedback.notice) this.notify(feedback.notice, 8000);
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

	private enqueue(path: string, job: () => Promise<unknown>): void {
		const previous = this.tails.get(path) ?? Promise.resolve();
		const next = previous.then(job, job);
		this.tails.set(path, next);
		void next.finally(() => {
			if (this.tails.get(path) === next) this.tails.delete(path);
		});
	}

	private async publishFile(
		file: TFile,
		source: 'command' | 'autosave' | 'publish-and-post',
	): Promise<'published' | 'stopped'> {
		const interactive = source !== 'autosave';
		if (!this.alive) return 'stopped';
		if (isSiteConflictFile(file.path)) {
			if (interactive) {
				this.notify(
					'This file is a conflict copy from the site. Merge it into the original note, delete it, and publish the original.',
					8000,
				);
			}
			return 'stopped';
		}

		if (!(await this.ensureSyncFolder('manual'))) return 'stopped';

		if (!pathInsideSyncFolder(this.settings.syncFolder, file.path)) {
			if (interactive) this.offerToMove(file);
			return 'stopped';
		}

		const mapped = toApiPath(this.settings.syncFolder, file.path);
		if (!mapped.ok) {
			if (interactive) this.notify(mapped.reason, 8000);
			return 'stopped';
		}

		const siblings = this.siblingNames(file.path);
		if (
			source === 'autosave' &&
			hasOpenConflict(file.path, siblings) &&
			this.settings.conflictRevisions[mapped.apiPath]
		) {
			return 'stopped';
		}

		const content = await this.readNote(file, source);
		let published = false;
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
				if (interactive) this.notify(outcome.message, 8000);
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
				published = true;
				if (source === 'command') await this.afterManualPublish(file, content);
				return;
			}
			if (outcome.kind === 'conflict') {
				await this.writeVaultFile(outcome.conflictVaultPath, outcome.remote.content);
				this.settings.conflictRevisions[mapped.apiPath] = outcome.remote.revision;
				await this.saveSettings();
				this.notify(outcome.message, 10000);
				return;
			}
			if (outcome.code === 'moved' && outcome.location) {
				await this.followMoved(mapped.apiPath, outcome.location, outcome.revision);
				return;
			}
			if (outcome.code === 'gone' || outcome.code === 'deleted') {
				this.offerRestore(mapped.apiPath, outcome.revision, outcome.message);
				return;
			}
			this.notify(outcome.message, 8000);
		});
		return published ? 'published' : 'stopped';
	}

	private async readNote(
		file: TFile,
		source: 'command' | 'autosave' | 'publish-and-post',
	): Promise<string> {
		if (source !== 'autosave') {
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

	private async ensureSyncFolder(source: PullSource): Promise<boolean> {
		const folder = normalizeSyncFolder(this.settings.syncFolder);
		const problem = folderProblem(this.settings.syncFolder);
		if (problem || !folder) {
			this.reportPullProblem(source, problem ?? 'Set a vault folder to sync.');
			return false;
		}
		try {
			await this.ensureFolder(`${folder}/note.md`);
			return true;
		} catch (error) {
			this.reportPullProblem(source, explainError(error));
			return false;
		}
	}

	private reportPullProblem(source: PullSource, message: string): void {
		if (source === 'auto') this.reportAutoFailure(message);
		else this.notify(message, 8000);
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

	private async withClient(
		run: (client: NotesClient) => Promise<void>,
		onError?: (message: string) => void,
	): Promise<void> {
		const report = onError ?? ((message: string) => this.notify(message, 8000));
		let client: NotesClient;
		try {
			client = new NotesClient(this.http, this.settings.baseUrl, this.settings.apiToken);
		} catch (error) {
			report(explainError(error));
			return;
		}
		try {
			await run(client);
		} catch (error) {
			report(explainError(error));
		}
	}

	private async onVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!this.alive || !this.vaultReady) return;
		if (this.remoteWrites.has(file.path) || this.remoteWrites.has(oldPath)) return;
		if (file instanceof TFolder) {
			for (const child of this.markdownUnder(file)) {
				const suffix = child.path.slice(file.path.length);
				await this.onNoteRename(child, `${oldPath}${suffix}`);
			}
			return;
		}
		if (file instanceof TFile && file.extension === 'md') await this.onNoteRename(file, oldPath);
	}

	private async onNoteRename(file: TFile, oldPath: string): Promise<void> {
		const plan = planVaultRename(this.settings.syncFolder, oldPath, file.path);
		if (plan.kind === 'ignore') return;
		if (plan.kind === 'entered-folder') {
			this.onVaultFile(file);
			return;
		}
		const record = this.settings.synced[plan.fromApiPath];
		if (plan.kind === 'left-folder') {
			if (!record) return;
			this.queueSiteDelete({ apiPath: plan.fromApiPath, revision: record.revision, kind: 'left-folder' });
			return;
		}
		if (!record && !this.moveChain.has(plan.fromApiPath)) return;
		void this.moveChain.enqueue(
			plan.fromApiPath,
			plan.toApiPath,
			record?.revision,
			(from, to, revision) => this.moveOnSite(file, from, to, revision),
		);
	}

	private async onVaultDelete(file: TAbstractFile): Promise<void> {
		if (!this.alive || !this.vaultReady) return;
		if (this.remoteWrites.has(file.path)) return;
		if (file instanceof TFolder) {
			for (const apiPath of this.syncedUnderVaultPath(file.path)) {
				const revision = this.settings.synced[apiPath]?.revision;
				if (revision) this.queueSiteDelete({ apiPath, revision, kind: 'deleted' });
			}
			return;
		}
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		const mapped = toApiPath(this.settings.syncFolder, file.path);
		if (!mapped.ok) return;
		const revision = this.settings.synced[mapped.apiPath]?.revision;
		if (!revision) return;
		this.queueSiteDelete({ apiPath: mapped.apiPath, revision, kind: 'deleted' });
	}

	private queueSiteDelete(item: {
		apiPath: string;
		revision: string;
		kind: 'deleted' | 'left-folder';
	}): void {
		if (this.pendingSiteDeletes.has(item.apiPath)) return;
		if (this.siteDeleteQueue.some((queued) => queued.apiPath === item.apiPath)) return;
		this.siteDeleteQueue.push(item);
		if (this.siteDeleteFlush !== null) return;
		this.siteDeleteFlush = window.setTimeout(() => {
			this.siteDeleteFlush = null;
			const batch = this.siteDeleteQueue.splice(0);
			this.flushSiteDeletes(batch);
		}, 0);
	}

	private flushSiteDeletes(
		batch: { apiPath: string; revision: string; kind: 'deleted' | 'left-folder' }[],
	): void {
		if (!this.alive || batch.length === 0) return;
		const choice = planDeleteBatch({
			count: batch.length,
			setting: this.settings.siteDelete,
			leftFolder: batch.length === 1 && batch[0]?.kind === 'left-folder',
		});
		if (choice === 'keep') return;
		if (choice === 'delete') {
			for (const item of batch) void this.deleteOnSite(item.apiPath, item.revision);
			return;
		}
		const only = batch[0];
		const prompt =
			batch.length === 1 && only
				? only.kind === 'left-folder'
					? leftFolderPrompt(only.apiPath)
					: siteDeletePrompt(only.apiPath)
				: bulkDeletePrompt(batch.length);
		new SiteDeleteModal(this.app, prompt, (answer) => {
			if (answer === 'delete') {
				for (const item of batch) void this.deleteOnSite(item.apiPath, item.revision);
				return;
			}
			this.notify(
				batch.length === 1 && only
					? `Left ${only.apiPath} on the site.`
					: `Left ${batch.length} notes on the site.`,
			);
		}).open();
	}

	private async moveOnSite(
		file: TFile,
		fromApiPath: string,
		toApiPath: string,
		revision: string,
	): Promise<string | null> {
		let nextRevision: string | null = null;
		await this.withClient(async (client) => {
			try {
				const note = await client.move(fromApiPath, toApiPath, revision);
				await this.retargetSync(fromApiPath, toApiPath, note.revision, file.path);
				nextRevision = note.revision;
				this.notify(`Renamed ${fromApiPath} to ${toApiPath} on the site. The old link redirects.`);
			} catch (error) {
				if (error instanceof NotesApiError && error.code === 'moved' && error.location) {
					await this.followMoved(fromApiPath, error.location, error.note?.revision);
					const followed = canonicalApiPath(error.location);
					nextRevision = followed ? (this.settings.synced[followed]?.revision ?? null) : null;
					return;
				}
				if (error instanceof NotesApiError && (error.code === 'gone' || error.code === 'deleted')) {
					this.offerRestore(fromApiPath, error.note?.revision ?? revision, error.message);
					return;
				}
				throw error;
			}
		});
		return nextRevision;
	}

	private async deleteOnSite(apiPath: string, revision: string): Promise<void> {
		if (this.pendingSiteDeletes.has(apiPath)) return;
		this.pendingSiteDeletes.add(apiPath);
		try {
			await this.deleteOnSiteNow(apiPath, revision);
		} finally {
			this.pendingSiteDeletes.delete(apiPath);
		}
	}

	private async deleteOnSiteNow(apiPath: string, revision: string): Promise<void> {
		await this.withClient(async (client) => {
			try {
				await client.remove(apiPath, revision);
			} catch (error) {
				if (error instanceof NotesApiError && (error.code === 'gone' || error.code === 'deleted')) {
					// Already in the trash.
				} else if (error instanceof NotesApiError && error.code === 'revision_conflict') {
					this.notify('The site copy changed, so it was not deleted.', 8000);
					return;
				} else {
					throw error;
				}
			}
			delete this.settings.synced[apiPath];
			delete this.settings.conflictRevisions[apiPath];
			await this.saveSettings();
			this.notify(`Moved ${apiPath} to the site trash. It can be restored.`);
		});
	}

	private async followMoved(fromApiPath: string, location: string, revision: string | undefined): Promise<void> {
		const target = canonicalApiPath(location);
		if (!target) {
			this.notify(`That note moved on the site, but “${location}” is not a path this plugin can write.`, 8000);
			return;
		}
		const record = this.settings.synced[fromApiPath];
		const fromVault = vaultPathForApi(this.settings.syncFolder, fromApiPath);
		const moved = await this.applyRemoteMove({
			fromApiPath,
			toApiPath: target,
			revision: revision ?? record?.revision,
		});
		if (moved) {
			await this.saveSettings();
			this.notify(`The site moved ${fromApiPath} to ${target}. The vault note followed it.`);
			return;
		}
		this.notify(
			`${fromVault} was left in place. On the site that note is now ${target}.`,
			8000,
		);
	}

	private async applyRemoteMove(move: RemoteMove): Promise<boolean> {
		const fromVault = vaultPathForApi(this.settings.syncFolder, move.fromApiPath);
		const toVault = vaultPathForApi(this.settings.syncFolder, move.toApiPath);
		const fromFile = this.app.vault.getAbstractFileByPath(fromVault);
		const toFile = this.app.vault.getAbstractFileByPath(toVault);
		if (fromFile instanceof TFile && !(toFile instanceof TFile) && !toFile) {
			this.remoteWrites.add(fromVault);
			this.remoteWrites.add(toVault);
			try {
				await this.app.fileManager.renameFile(fromFile, toVault);
			} catch (error) {
				this.notify(explainError(error), 8000);
				return false;
			} finally {
				window.setTimeout(() => {
					this.remoteWrites.delete(fromVault);
					this.remoteWrites.delete(toVault);
				}, 1000);
			}
		} else if (fromFile instanceof TFile && toFile) {
			this.notify(
				`The site moved ${move.fromApiPath} to ${move.toApiPath}, and both files are already in the vault. Neither was overwritten.`,
				10000,
			);
			return false;
		}
		const record = this.settings.synced[move.fromApiPath];
		if (record) {
			this.settings.synced[move.toApiPath] = {
				revision: move.revision || record.revision,
				fingerprint: record.fingerprint,
			};
			delete this.settings.synced[move.fromApiPath];
			const conflict = this.settings.conflictRevisions[move.fromApiPath];
			if (conflict) {
				this.settings.conflictRevisions[move.toApiPath] = conflict;
				delete this.settings.conflictRevisions[move.fromApiPath];
			}
		}
		return true;
	}

	private async retargetSync(
		fromApiPath: string,
		toApiPath: string,
		revision: string,
		vaultPath: string,
	): Promise<void> {
		let fingerprint = this.settings.synced[fromApiPath]?.fingerprint;
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (file instanceof TFile) {
			fingerprint = contentFingerprint(await this.app.vault.read(file));
		}
		if (fingerprint) {
			this.settings.synced[toApiPath] = { revision, fingerprint };
		}
		delete this.settings.synced[fromApiPath];
		if (this.settings.conflictRevisions[fromApiPath]) {
			this.settings.conflictRevisions[toApiPath] = this.settings.conflictRevisions[fromApiPath];
			delete this.settings.conflictRevisions[fromApiPath];
		}
		await this.saveSettings();
	}

	private offerRestore(apiPath: string, revision: string | undefined, message: string): void {
		const fragment = document.createDocumentFragment();
		const wrap = fragment.createDiv({ cls: 'oddava-notes-move-notice' });
		wrap.createEl('div', { text: message });
		const button = wrap.createEl('button', { text: 'Restore' });
		const notice = new Notice(fragment, 20000);
		button.addEventListener('click', () => {
			notice.hide();
			if (!this.alive) return;
			void this.restoreOnSite(apiPath, revision);
		});
	}

	private async restoreOnSite(apiPath: string, revision: string | undefined): Promise<void> {
		await this.withClient(async (client) => {
			const note = await client.restore(apiPath, revision);
			const vaultPath = vaultPathForApi(this.settings.syncFolder, apiPath);
			const existing = this.app.vault.getAbstractFileByPath(vaultPath);
			const localContent = existing instanceof TFile ? await this.app.vault.read(existing) : undefined;
			const syncedFingerprint = this.settings.synced[apiPath]?.fingerprint;
			const plan = planRestore({
				localExists: localContent !== undefined,
				localFingerprint: localContent !== undefined ? contentFingerprint(localContent) : undefined,
				syncedFingerprint,
			});
			if (plan === 'write-restored') {
				const content =
					localContent !== undefined ? preserveTelegramFrontmatter(localContent, note.content) : note.content;
				await this.writeVaultFile(vaultPath, content);
				this.settings.synced[apiPath] = {
					revision: note.revision,
					fingerprint: contentFingerprint(content),
				};
				await this.saveSettings();
				this.notify(`Restored ${apiPath} from the site trash.`);
				return;
			}
			// Local text changed since the last sync. Keep that file. Park the
			// restored copy beside it, then publish the local text onto the
			// revision restore just created.
			const siblings = this.siblingNames(vaultPath);
			const conflictPath = nextConflictVaultPath(vaultPath, siblings);
			await this.writeVaultFile(conflictPath, note.content);
			const published = await publishNote(client, {
				apiPath,
				vaultPath,
				content: localContent ?? '',
				revision: note.revision,
				siblingNames: siblings,
			});
			if (published.kind === 'published') {
				this.settings.synced[apiPath] = {
					revision: published.revision,
					fingerprint: published.fingerprint,
				};
				delete this.settings.conflictRevisions[apiPath];
				await this.saveSettings();
				this.notify(
					`Kept your edits in ${apiPath}. Saved the restored copy beside the note and published your text.`,
					10000,
				);
				return;
			}
			this.settings.synced[apiPath] = {
				revision: note.revision,
				fingerprint: contentFingerprint(note.content),
			};
			this.settings.conflictRevisions[apiPath] = note.revision;
			await this.saveSettings();
			this.notify(
				`Restored ${apiPath} on the site, kept your local edits, and saved the site copy beside the note. ${published.kind === 'blocked' || published.kind === 'conflict' || published.kind === 'error' ? published.message : ''}`,
				10000,
			);
		});
	}

	private markdownUnder(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		const walk = (node: TFolder) => {
			for (const child of node.children) {
				if (child instanceof TFile && child.extension === 'md') files.push(child);
				else if (child instanceof TFolder) walk(child);
			}
		};
		walk(folder);
		return files;
	}

	private syncedUnderVaultPath(folderPath: string): string[] {
		const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
		const paths: string[] = [];
		for (const apiPath of Object.keys(this.settings.synced)) {
			const vaultPath = vaultPathForApi(this.settings.syncFolder, apiPath);
			if (vaultPath === folderPath || vaultPath.startsWith(prefix)) paths.push(apiPath);
		}
		return paths;
	}

	private notify(message: string, timeout = 5000): void {
		if (!this.alive) return;
		const hidden = redact(redact(message, this.settings.apiToken), this.settings.telegramBotToken);
		new Notice(hidden, timeout);
	}

	private async postActiveToTelegram(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== 'md') {
			this.notify('Open a Markdown note to post to Telegram.', 6000);
			return;
		}
		await this.postFileToTelegram(file);
	}

	private async postFileToTelegram(file: TFile): Promise<void> {
		const content = await this.readNote(file, 'command');
		await this.openTelegramPost(file, content);
	}

	private async openTelegramPost(file: TFile, content: string): Promise<void> {
		if (!this.alive) return;
		const tokenProblem = telegramTokenProblem(this.settings.telegramBotToken);
		if (tokenProblem) {
			this.notify(tokenProblem, 8000);
			return;
		}
		const prepared = prepareTelegramPost({
			vaultPath: file.path,
			syncFolder: this.settings.syncFolder,
			content,
			baseUrl: this.settings.baseUrl,
			channel: this.settings.telegramChannel,
			publishedRevision: this.publishedRevision(file.path),
			fingerprint: this.publishedFingerprint(file.path),
		});
		if (!prepared.ok) {
			this.notify(prepared.reason, 8000);
			return;
		}
		const draft = prepared.draft;
		new TelegramPostModal(this.app, draft, {
			sendNew: () => this.sendNewTelegramPost(file, draft),
			updateExisting: draft.messageId ? () => this.updateTelegramPost(file, draft) : undefined,
		}).open();
	}

	/**
	 * Manual Publish only. A flagged note with real text and no message id is
	 * posted. A note that was already posted is edited when the text changed.
	 * Publish on save does not call this.
	 */
	private async afterManualPublish(file: TFile, content: string): Promise<void> {
		const rendered = this.renderTelegram(file.path, content);
		if (!rendered) {
			const meta = readTelegramFrontmatter(content);
			if (meta.enabled || meta.messageId) {
				this.notify('Could not build the Telegram post. Check the channel and the site URL.', 8000);
			}
			return;
		}
		const followUp = telegramFollowUp('command', content, rendered.plain);
		if (followUp.kind === 'skip') return;
		if (followUp.kind === 'too-short') {
			this.notify(followUp.notice, 6000);
			return;
		}
		if (followUp.kind === 'post') {
			await this.sendNewTelegramPost(file, rendered);
			return;
		}
		if (followUp.unchanged) return;
		await this.updateTelegramPost(file, { ...rendered, messageId: followUp.messageId });
	}

	private renderTelegram(vaultPath: string, content: string): TelegramPostDraft | null {
		// Do not substitute a placeholder revision. prepareTelegramPost treats any
		// non-empty string as already published.
		const publishedRevision = this.publishedRevision(vaultPath);
		if (!publishedRevision) return null;
		const prepared = prepareTelegramPost({
			vaultPath,
			syncFolder: this.settings.syncFolder,
			content,
			baseUrl: this.settings.baseUrl,
			channel: this.settings.telegramChannel,
			publishedRevision,
		});
		return prepared.ok ? prepared.draft : null;
	}

	private publishedRevision(vaultPath: string): string | undefined {
		const mapped = toApiPath(this.settings.syncFolder, vaultPath);
		if (!mapped.ok) return undefined;
		return this.settings.synced[mapped.apiPath]?.revision;
	}

	private publishedFingerprint(vaultPath: string): string | undefined {
		const mapped = toApiPath(this.settings.syncFolder, vaultPath);
		if (!mapped.ok) return undefined;
		return this.settings.synced[mapped.apiPath]?.fingerprint;
	}

	private async sendNewTelegramPost(file: TFile, draft: TelegramPostDraft): Promise<boolean> {
		return this.withTelegramSend(draft.apiPath, async () => {
			const sent = await sendTelegramMessage(this.http, {
				token: this.settings.telegramBotToken,
				chatId: this.settings.telegramChannel,
				html: draft.html,
			});
			await this.recordTelegramMessage(file, draft.apiPath, sent.messageId, draft.plain);
			this.notify(`Posted to ${this.settings.telegramChannel}.`);
			return true;
		});
	}

	private async updateTelegramPost(file: TFile, draft: TelegramPostDraft): Promise<boolean> {
		const messageId = draft.messageId;
		if (!messageId) return false;
		if (draft.unchanged) {
			this.notify('The Telegram post already matches this note.');
			return true;
		}
		return this.withTelegramSend(draft.apiPath, async () => {
			const html = draft.html || telegramHtml(draft.title, draft.excerpt, draft.url);
			let unchanged = false;
			try {
				unchanged = (await editTelegramMessage(this.http, {
					token: this.settings.telegramBotToken,
					chatId: this.settings.telegramChannel,
					messageId,
					html,
				})) === 'unchanged';
			} catch (error) {
				if (error instanceof TelegramPostDeleted) {
					this.notify(error.message, 10000);
					return false;
				}
				throw error;
			}
			await this.recordTelegramMessage(file, draft.apiPath, messageId, draft.plain);
			this.notify(
				unchanged
					? 'The Telegram post already matches this note.'
					: `Updated the post on ${this.settings.telegramChannel}.`,
			);
			return true;
		});
	}

	private async withTelegramSend(apiPath: string, run: () => Promise<boolean>): Promise<boolean> {
		if (this.telegramSending.has(apiPath)) {
			this.notify('That note is already being posted.');
			return false;
		}
		const tokenProblem = telegramTokenProblem(this.settings.telegramBotToken);
		if (tokenProblem) {
			this.notify(tokenProblem, 8000);
			return false;
		}
		this.telegramSending.add(apiPath);
		try {
			return await run();
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Could not reach Telegram.';
			this.notify(message, 8000);
			return false;
		} finally {
			this.telegramSending.delete(apiPath);
		}
	}

	private async recordTelegramMessage(
		file: TFile,
		apiPath: string,
		messageId: number,
		plain: string,
	): Promise<void> {
		const current = await this.readNote(file, 'command');
		const next = withTelegramMessageId(current, messageId, plain);
		await this.writeVaultFile(file.path, next);
		const synced = this.settings.synced[apiPath];
		if (!synced) return;
		this.settings.synced[apiPath] = {
			revision: synced.revision,
			fingerprint: contentFingerprint(next),
		};
		await this.saveSettings();
	}

	private async withLocalTelegramFields(vaultPath: string, incoming: string): Promise<string> {
		const existing = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(existing instanceof TFile)) return incoming;
		try {
			const local = await this.app.vault.read(existing);
			return preserveTelegramFrontmatter(local, incoming);
		} catch {
			return incoming;
		}
	}
}
