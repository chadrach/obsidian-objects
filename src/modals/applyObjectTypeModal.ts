import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	TFile,
} from "obsidian";
import { ObjectTypeDefinition } from "../types";
import { ObjectTypeManager } from "../objectTypeManager";
import { trackVisualViewportForModal } from "../mobileViewport";

/**
 * Shown when a markdown note is created or moved into a typed folder outside
 * of the plugin's own note-creation flow. Offers to apply the folder's object
 * type template (type identifier + default properties) to the note.
 *
 * Choosing "Skip" leaves the note untouched. Choosing "Apply" calls
 * `ObjectTypeManager.stampObjectType` which adds the type key and any missing
 * properties without touching existing frontmatter or moving the file.
 *
 * When multiple notes are queued, `remainingCount` is the number of notes
 * after this one. The modal then also shows "Apply to all" / "Skip all"
 * buttons for batch handling.
 */
export class ApplyObjectTypeModal extends Modal {
	private keyboardCleanup: (() => void) | null = null;
	private doneFired = false;

	constructor(
		app: App,
		private readonly manager: ObjectTypeManager,
		private readonly file: TFile,
		private readonly type: ObjectTypeDefinition,
		private readonly opts: {
			remainingCount?: number;
			onApplyAll?: () => void;
			onSkipAll?: () => void;
			onDone?: () => void;
		} = {}
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("obsidian-objects-modal");
		this.keyboardCleanup = trackVisualViewportForModal(this.modalEl);
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		const { remainingCount = 0 } = this.opts;
		const total = remainingCount + 1;

		this.titleEl.setText(`Apply ${this.type.name} template?`);

		if (remainingCount > 0) {
			this.contentEl.createDiv({
				cls: "obsidian-objects-apply-queue",
				text: `${total} notes are waiting — showing 1 of ${total}.`,
			});
		}

		const desc = this.contentEl.createDiv({
			cls: "obsidian-objects-apply-desc",
		});
		desc.appendText("This note was added to the ");
		desc.createEl("strong", { text: this.type.name });
		desc.appendText(
			" folder. Apply its template to add the standard properties?"
		);

		// Determine what will actually be added so the user can see exactly
		// what's about to change before confirming.
		const cache = this.app.metadataCache.getFileCache(this.file);
		const existingFm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		const typeKey = this.manager.getSettings().typePropertyName;
		const qualifiedName = this.manager.getQualifiedName(this.type);
		const props = this.manager.getEffectiveProperties(this.type);
		const chain = this.manager.getTypeChain(this.type);

		const willAdd: Array<{ name: string; detail: string }> = [];
		if (
			chain.some((t) => t.showTypeProperty) &&
			existingFm[typeKey] !== qualifiedName
		) {
			willAdd.push({
				name: typeKey,
				detail: `"${qualifiedName}"`,
			});
		}
		for (const prop of props) {
			if (!(prop.name in existingFm)) {
				willAdd.push({ name: prop.name, detail: prop.type });
			}
		}
		if (chain.some((t) => t.showTags) && !("tags" in existingFm)) {
			willAdd.push({ name: "tags", detail: "tags" });
		}
		if (chain.some((t) => t.showAliases) && !("aliases" in existingFm)) {
			willAdd.push({ name: "aliases", detail: "aliases" });
		}

		if (willAdd.length > 0) {
			this.contentEl.createEl("h3", { text: "Properties to add" });
			const list = this.contentEl.createEl("ul", {
				cls: "obsidian-objects-add-list",
			});
			for (const item of willAdd) {
				const li = list.createEl("li");
				li.createEl("code", { text: item.name });
				li.appendText(` — ${item.detail}`);
			}
		}

		const footer = this.contentEl.createDiv({
			cls: "obsidian-objects-modal__footer",
		});

		if (remainingCount > 0) {
			// Batch actions — left-aligned so they read as secondary choices.
			const batchArea = footer.createDiv({
				cls: "obsidian-objects-apply-batch",
			});
			new ButtonComponent(batchArea)
				.setButtonText(`Skip all ${total}`)
				.onClick(() => {
					this.opts.onSkipAll?.();
					this.fireDone();
					this.close();
				});
			new ButtonComponent(batchArea)
				.setButtonText(`Apply to all ${total}`)
				.onClick(() => void this.handleApplyAll());
		}

		new ButtonComponent(footer)
			.setButtonText("Skip")
			.onClick(() => {
				this.fireDone();
				this.close();
			});
		new ButtonComponent(footer)
			.setButtonText(`Apply ${this.type.name} template`)
			.setCta()
			.onClick(() => void this.handleApply());
	}

	private async handleApply(): Promise<void> {
		try {
			await this.manager.stampObjectType(this.file, this.type);
			new Notice(`Applied ${this.type.name} template`);
		} catch (err) {
			console.error(err);
			new Notice(`Failed to apply template: ${err}`);
		}
		this.fireDone();
		this.close();
	}

	private async handleApplyAll(): Promise<void> {
		try {
			await this.manager.stampObjectType(this.file, this.type);
			new Notice(`Applied ${this.type.name} template`);
		} catch (err) {
			console.error(err);
			new Notice(`Failed to apply template: ${err}`);
		}
		this.opts.onApplyAll?.();
		this.fireDone();
		this.close();
	}

	/** Fire the `onDone` callback exactly once (guards against double-fire). */
	private fireDone(): void {
		if (this.doneFired) return;
		this.doneFired = true;
		this.opts.onDone?.();
	}

	onClose(): void {
		this.keyboardCleanup?.();
		this.keyboardCleanup = null;
		// Fallback: covers escape-key / click-outside dismissal where no
		// explicit action handler ran.
		this.fireDone();
	}
}
