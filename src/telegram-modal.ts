import { Modal, type App } from 'obsidian';
import type { TelegramPostDraft } from './telegram';

/**
 * Shows the exact post and waits. Cancel sends nothing.
 * A note that already has a message id can update that post or send a new one.
 */
export class TelegramPostModal extends Modal {
	constructor(
		app: App,
		private readonly draft: TelegramPostDraft,
		private readonly actions: {
			sendNew: () => Promise<boolean>;
			updateExisting?: () => Promise<boolean>;
		},
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Post to Telegram');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oddava-notes-telegram');

		for (const warning of this.draft.warnings) {
			contentEl.createEl('p', { text: warning, cls: 'oddava-notes-telegram-warning' });
		}

		contentEl.createEl('p', {
			text: 'The title line is bold on Telegram. Nothing is sent until you choose Send or Update.',
			cls: 'oddava-notes-telegram-note',
		});
		contentEl.createEl('pre', { text: this.draft.plain, cls: 'oddava-notes-telegram-preview' });

		const row = contentEl.createDiv({ cls: 'oddava-notes-telegram-actions' });
		if (this.draft.messageId && this.actions.updateExisting) {
			this.actionButton(row, 'Update existing', 'mod-cta', this.actions.updateExisting);
			this.actionButton(row, 'Post new', '', this.actions.sendNew);
		} else {
			this.actionButton(row, 'Send', 'mod-cta', this.actions.sendNew);
		}
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => {
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private actionButton(
		parent: HTMLElement,
		label: string,
		cls: string,
		run: () => Promise<boolean>,
	): void {
		const button = parent.createEl('button', { text: label, cls: cls || undefined });
		button.type = 'button';
		button.addEventListener('click', () => {
			if (button.disabled) return;
			button.disabled = true;
			const original = button.textContent;
			button.textContent = 'Sending…';
			void run().then(
				(done) => {
					if (done) this.close();
					else {
						button.disabled = false;
						button.textContent = original;
					}
				},
				() => {
					button.disabled = false;
					button.textContent = original;
				},
			);
		});
	}
}
