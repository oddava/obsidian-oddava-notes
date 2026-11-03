import { Modal, setIcon, type App } from 'obsidian';
import {
	describeParts,
	TELEGRAM_FORMATS,
	TELEGRAM_LINK_PREVIEWS,
	type TelegramPostDraft,
} from './telegram';
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT, type Mark, type Run } from './telegram-format';

export interface TelegramModalActions {
	sendNew: () => Promise<boolean>;
	/** Edit the existing post in place. Absent when the layout cannot be edited. */
	updateExisting?: () => Promise<boolean>;
	/** Send the post again, then delete the old messages. */
	replaceExisting?: () => Promise<boolean>;
}

/**
 * Shows every message of the post, formatted the way Telegram will show it,
 * and waits. Cancel sends nothing.
 */
export class TelegramPostModal extends Modal {
	private readonly buttons: HTMLButtonElement[] = [];
	private busy = false;

	constructor(
		app: App,
		private readonly draft: TelegramPostDraft,
		private readonly actions: TelegramModalActions,
		/** Image source for the cover preview, if it can be shown. */
		private readonly coverSrc?: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { draft } = this;
		this.setTitle('Post to Telegram');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oddava-notes-telegram');

		const facts = [
			`To ${draft.channel}`,
			describeParts(draft.parts),
			TELEGRAM_FORMATS[draft.format],
		];
		facts.push(draft.silent ? 'Silent' : 'With notification');
		facts.push(draft.pin ? 'Will be pinned (new posts only)' : 'Not pinned');
		if (!draft.cover) facts.push(TELEGRAM_LINK_PREVIEWS[draft.linkPreview]);
		contentEl.createEl('p', { text: facts.join(' · '), cls: 'oddava-notes-telegram-facts' });

		for (const warning of draft.warnings) {
			contentEl.createEl('p', { text: warning, cls: 'oddava-notes-telegram-warning' });
		}

		const list = contentEl.createDiv({ cls: 'oddava-notes-telegram-messages' });
		draft.parts.forEach((part, index) => {
			const card = list.createDiv({ cls: 'oddava-notes-telegram-message' });
			const header = card.createDiv({ cls: 'oddava-notes-telegram-message-header' });
			const label =
				draft.parts.length > 1 ? `Message ${index + 1} of ${draft.parts.length}` : 'Message';
			header.createSpan({ text: part.kind === 'photo' ? `${label} · photo` : label });
			const limit = part.kind === 'photo' ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;
			header.createSpan({
				text: `${part.text.length.toLocaleString()} / ${limit.toLocaleString()}`,
				cls: 'oddava-notes-telegram-count',
			});

			if (part.kind === 'photo' && draft.cover) {
				const media = card.createDiv({ cls: 'oddava-notes-telegram-photo' });
				if (this.coverSrc) {
					const image = media.createEl('img', { attr: { src: this.coverSrc, alt: draft.cover.label } });
					image.addEventListener('error', () => {
						image.remove();
						photoPlaceholder(media, draft.cover?.label ?? '');
					});
				} else {
					photoPlaceholder(media, draft.cover.label);
				}
			}

			const preview = part.linkPreview;
			const cardAbove = preview && !preview.is_disabled && preview.show_above_text;
			if (cardAbove) linkCard(card, draft.url, preview.prefer_small_media === true);
			const body = card.createDiv({ cls: 'oddava-notes-telegram-text' });
			renderRunsInto(body, part.text.runs);
			if (preview && !preview.is_disabled && !cardAbove) {
				linkCard(card, draft.url, preview.prefer_small_media === true);
			}
		});

		const row = contentEl.createDiv({ cls: 'oddava-notes-telegram-actions' });
		if (draft.existing) {
			if (this.actions.updateExisting) {
				this.actionButton(row, draft.unchanged ? 'Up to date' : 'Update post', true, this.actions.updateExisting, draft.unchanged);
			}
			if (this.actions.replaceExisting) {
				this.actionButton(row, 'Replace post', !this.actions.updateExisting, this.actions.replaceExisting);
			}
			this.actionButton(row, 'Post new', false, this.actions.sendNew);
		} else {
			this.actionButton(row, 'Send', true, this.actions.sendNew);
		}
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => {
			if (!this.busy) this.close();
		});
		this.buttons.push(cancel);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private actionButton(
		parent: HTMLElement,
		label: string,
		primary: boolean,
		run: () => Promise<boolean>,
		disabled = false,
	): void {
		const button = parent.createEl('button', { text: label, cls: primary ? 'mod-cta' : undefined });
		button.type = 'button';
		button.disabled = disabled;
		this.buttons.push(button);
		button.addEventListener('click', () => {
			if (button.disabled || this.busy) return;
			this.busy = true;
			const states = this.buttons.map((each) => each.disabled);
			for (const each of this.buttons) each.disabled = true;
			button.textContent = 'Sending…';
			const restore = (): void => {
				this.busy = false;
				this.buttons.forEach((each, index) => {
					each.disabled = states[index] ?? false;
				});
				button.textContent = label;
			};
			void run().then(
				(done) => {
					if (done) {
						this.busy = false;
						this.close();
					} else restore();
				},
				restore,
			);
		});
	}
}

function photoPlaceholder(parent: HTMLElement, label: string): void {
	const box = parent.createDiv({ cls: 'oddava-notes-telegram-photo-placeholder' });
	const icon = box.createSpan();
	setIcon(icon, 'image');
	box.createSpan({ text: label });
}

function linkCard(parent: HTMLElement, url: string, small: boolean): void {
	const card = parent.createDiv({
		cls: `oddava-notes-telegram-link-card${small ? ' is-small' : ''}`,
	});
	const icon = card.createSpan();
	setIcon(icon, 'link');
	card.createSpan({ text: `Link preview: ${url}` });
}

/** Draw runs as nested elements, the same nesting Telegram's HTML uses. */
export function renderRunsInto(parent: HTMLElement, runs: Run[]): void {
	const stack: Array<{ mark: Mark; el: HTMLElement }> = [];
	for (const run of runs) {
		let common = 0;
		while (
			common < stack.length &&
			common < run.marks.length &&
			sameMark(stack[common]?.mark, run.marks[common])
		) {
			common += 1;
		}
		stack.length = common;
		for (let index = common; index < run.marks.length; index += 1) {
			const mark = run.marks[index] as Mark;
			const host = stack[stack.length - 1]?.el ?? parent;
			stack.push({ mark, el: elementFor(host, mark) });
		}
		const host = stack[stack.length - 1]?.el ?? parent;
		host.appendText(run.text);
	}
}

function elementFor(parent: HTMLElement, mark: Mark): HTMLElement {
	switch (mark.type) {
		case 'b':
			return parent.createEl('strong');
		case 'i':
			return parent.createEl('em');
		case 'u':
			return parent.createEl('u');
		case 's':
			return parent.createEl('s');
		case 'spoiler':
			return parent.createSpan({ cls: 'oddava-notes-telegram-spoiler' });
		case 'code':
			return parent.createEl('code');
		case 'pre':
			return parent.createEl('pre').createEl('code');
		case 'blockquote':
			return parent.createEl('blockquote', {
				cls: mark.expandable ? 'oddava-notes-telegram-expandable' : undefined,
			});
		case 'a': {
			const link = parent.createEl('a', { attr: { href: mark.href ?? '', title: mark.href ?? '' } });
			link.addEventListener('click', (event) => event.preventDefault());
			return link;
		}
		default:
			return parent.createSpan();
	}
}

function sameMark(left: Mark | undefined, right: Mark | undefined): boolean {
	if (!left || !right) return false;
	return (
		left.type === right.type &&
		left.href === right.href &&
		left.lang === right.lang &&
		Boolean(left.expandable) === Boolean(right.expandable)
	);
}
