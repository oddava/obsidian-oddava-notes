import { Modal, type App } from 'obsidian';
import { describeDigestWarning, type Digest, type DigestWarning } from './telegram-digest';
import { TELEGRAM_TEXT_LIMIT } from './telegram-format';
import { renderRunsInto } from './telegram-modal';

export interface DigestModalOptions {
	channel: string;
	silent: boolean;
	/** The diary setting in effect. The checkbox starts from it. */
	excludeDiary: boolean;
	warning: DigestWarning | null;
	/** Build the digest for the checkbox state. Null when no notes match. */
	build: (excludeDiary: boolean) => Digest | null;
	/** Send exactly this digest. True closes the modal. */
	send: (digest: Digest, excludeDiary: boolean) => Promise<boolean>;
}

/** Shows the exact digest and waits. Cancel sends nothing. */
export class TelegramDigestModal extends Modal {
	private excludeDiary: boolean;
	private busy = false;

	constructor(
		app: App,
		private readonly options: DigestModalOptions,
	) {
		super(app);
		this.excludeDiary = options.excludeDiary;
	}

	onOpen(): void {
		this.setTitle('Post weekly digest to Telegram');
		this.contentEl.addClass('oddava-notes-telegram');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl, options } = this;
		contentEl.empty();
		const digest = options.build(this.excludeDiary);

		const facts = [
			`To ${options.channel}`,
			digest ? `${digest.total} ${digest.total === 1 ? 'note' : 'notes'}` : 'No notes',
			this.excludeDiary ? 'Diary excluded' : 'Diary included',
			options.silent ? 'Silent' : 'With notification',
			'Not pinned',
			'No link preview',
		];
		contentEl.createEl('p', { text: facts.join(' · '), cls: 'oddava-notes-telegram-facts' });

		if (options.warning) {
			contentEl.createEl('p', {
				text: describeDigestWarning(options.warning),
				cls: 'oddava-notes-telegram-warning',
			});
		}

		const label = contentEl.createEl('label', { cls: 'oddava-notes-digest-diary' });
		const box = label.createEl('input', { attr: { type: 'checkbox' } });
		box.checked = this.excludeDiary;
		label.appendText(' Exclude diary');
		box.disabled = this.busy;
		box.addEventListener('change', () => {
			if (this.busy) return;
			this.excludeDiary = box.checked;
			this.render();
		});

		if (digest) {
			const card = contentEl.createDiv({ cls: 'oddava-notes-telegram-message' });
			const header = card.createDiv({ cls: 'oddava-notes-telegram-message-header' });
			header.createSpan({ text: 'Message' });
			header.createSpan({
				text: `${digest.plain.length.toLocaleString()} / ${TELEGRAM_TEXT_LIMIT.toLocaleString()}`,
				cls: 'oddava-notes-telegram-count',
			});
			renderRunsInto(card.createDiv({ cls: 'oddava-notes-telegram-text' }), digest.runs);
		} else {
			contentEl.createEl('p', { text: 'No notes updated in the last 7 days.' });
		}

		const row = contentEl.createDiv({ cls: 'oddava-notes-telegram-actions' });
		const send = row.createEl('button', { text: 'Send', cls: 'mod-cta' });
		send.type = 'button';
		send.disabled = !digest;
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => {
			if (!this.busy) this.close();
		});
		send.addEventListener('click', () => {
			if (!digest || this.busy) return;
			this.busy = true;
			send.disabled = true;
			cancel.disabled = true;
			box.disabled = true;
			send.textContent = 'Sending…';
			const restore = (): void => {
				this.busy = false;
				this.render();
			};
			void options.send(digest, this.excludeDiary).then((done) => {
				if (done) {
					this.busy = false;
					this.close();
				} else restore();
			}, restore);
		});
	}
}
