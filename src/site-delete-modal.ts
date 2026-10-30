import { Modal, type App } from 'obsidian';
import { DELETE_ON_SITE, KEEP_ON_SITE } from './vault-sync';

/** The vault file is already gone. This only decides the site trash. */
export class SiteDeleteModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly prompt: string,
		private readonly onChoose: (choice: 'delete' | 'keep') => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Delete on the site?');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: this.prompt });
		const row = contentEl.createDiv({ cls: 'oddava-notes-telegram-actions' });
		const remove = row.createEl('button', { text: DELETE_ON_SITE, cls: 'mod-warning' });
		remove.type = 'button';
		const keep = row.createEl('button', { text: KEEP_ON_SITE });
		keep.type = 'button';
		remove.addEventListener('click', () => {
			this.finish('delete');
		});
		keep.addEventListener('click', () => {
			this.finish('keep');
		});
	}

	onClose(): void {
		if (!this.settled) this.onChoose('keep');
		this.settled = true;
		this.contentEl.empty();
	}

	private finish(choice: 'delete' | 'keep'): void {
		if (this.settled) return;
		this.settled = true;
		this.onChoose(choice);
		this.close();
	}
}
