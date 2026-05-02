import { App, Modal, Setting } from "obsidian";
import { trackVisualViewportForModal } from "../mobileViewport";

export interface ConfirmOptions {
	title: string;
	body?: string | ((el: HTMLElement) => void);
	confirmText?: string;
	cancelText?: string;
	/** Optional third option, e.g. "Delete and keep existing values". */
	extraButtons?: Array<{ text: string; value: string }>;
}

/**
 * Small promise-based confirmation modal. Returns the id of the clicked
 * button, or null if the user dismissed the dialog.
 */
export function confirmAction(
	app: App,
	opts: ConfirmOptions
): Promise<"confirm" | "cancel" | string | null> {
	return new Promise((resolve) => {
		const modal = new ConfirmModal(app, opts, resolve);
		modal.open();
	});
}

class ConfirmModal extends Modal {
	private resolved = false;
	private keyboardCleanup: (() => void) | null = null;

	constructor(
		app: App,
		private readonly opts: ConfirmOptions,
		private readonly resolve: (
			value: "confirm" | "cancel" | string | null
		) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("obsidian-objects-modal");
		this.keyboardCleanup = trackVisualViewportForModal(this.modalEl);
		this.titleEl.setText(this.opts.title);
		if (typeof this.opts.body === "string") {
			this.contentEl.createEl("p", { text: this.opts.body });
		} else if (typeof this.opts.body === "function") {
			this.opts.body(this.contentEl);
		}

		const setting = new Setting(this.contentEl);
		for (const btn of this.opts.extraButtons ?? []) {
			setting.addButton((b) =>
				b.setButtonText(btn.text).onClick(() => this.finish(btn.value))
			);
		}
		setting.addButton((b) =>
			b
				.setButtonText(this.opts.cancelText ?? "Cancel")
				.onClick(() => this.finish("cancel"))
		);
		setting.addButton((b) =>
			b
				.setButtonText(this.opts.confirmText ?? "Confirm")
				.setCta()
				.onClick(() => this.finish("confirm"))
		);
	}

	onClose(): void {
		this.keyboardCleanup?.();
		this.keyboardCleanup = null;
		if (!this.resolved) this.resolve(null);
	}

	private finish(value: "confirm" | "cancel" | string): void {
		this.resolved = true;
		this.resolve(value);
		this.close();
	}
}
