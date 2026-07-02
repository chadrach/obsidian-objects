import {
	App,
	Editor,
	EditorPosition,
	Modal,
	Notice,
	TFile,
	setIcon,
} from "obsidian";
import { ObjectTypeDefinition } from "../types";
import { ObjectTypeManager } from "../objectTypeManager";
import { filenameWithoutExtension, uniquePath } from "../utils";
import { trackVisualViewportForModal } from "../mobileViewport";

type LinkItem =
	| { kind: "note"; file: TFile; type?: ObjectTypeDefinition }
	| { kind: "create"; title: string; type: ObjectTypeDefinition }
	| { kind: "create-untyped"; title: string };

/**
 * Modal opened when the trigger character (@) is pressed while text is
 * selected in the editor.
 *
 * Keeps the selected text in place and replaces it with a wikilink once the
 * user picks a note. The original selection becomes the display name (alias)
 * of the inserted link, so [[NoteName|selected text]] is inserted when the
 * note name and the selection differ.
 *
 * The search box is pre-filled with the selected text so matching notes
 * appear immediately, but the user can clear or change it to search for
 * anything.
 */
export class SelectionLinkModal extends Modal {
	private inputEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private items: LinkItem[] = [];
	private selectedIdx = 0;
	private keyboardCleanup: (() => void) | null = null;

	constructor(
		app: App,
		private readonly manager: ObjectTypeManager,
		private readonly editor: Editor,
		private readonly from: EditorPosition,
		private readonly to: EditorPosition,
		private readonly originalText: string,
		private readonly sourcePath: string
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("obsidian-objects-modal");
		this.keyboardCleanup = trackVisualViewportForModal(this.modalEl);
		this.titleEl.setText("Link selection");

		// Search input
		this.inputEl = this.contentEl.createEl("input", {
			cls: "obsidian-objects-selection-link__input",
			type: "text",
		});
		this.inputEl.value = this.originalText;
		this.inputEl.setAttribute("placeholder", "Search notes...");

		// Result list
		this.listEl = this.contentEl.createDiv({
			cls: "obsidian-objects-selection-link__list",
		});

		this.inputEl.addEventListener("input", () => {
			this.selectedIdx = 0;
			this.refresh();
		});

		this.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key === "ArrowDown") {
				evt.preventDefault();
				this.selectedIdx = Math.min(
					this.selectedIdx + 1,
					this.items.length - 1
				);
				this.renderList();
			} else if (evt.key === "ArrowUp") {
				evt.preventDefault();
				this.selectedIdx = Math.max(this.selectedIdx - 1, 0);
				this.renderList();
			} else if (evt.key === "Enter") {
				evt.preventDefault();
				void this.confirmSelection();
			}
			// Escape is handled by Modal base class (closes the modal).
		});

		this.refresh();

		// Focus and select all so the user can immediately type to replace
		// the pre-filled text with a different search term.
		requestAnimationFrame(() => {
			this.inputEl.focus();
			this.inputEl.select();
		});
	}

	onClose(): void {
		this.keyboardCleanup?.();
		this.keyboardCleanup = null;
	}

	// ---------- private ----------

	private refresh(): void {
		this.items = this.buildItems(this.inputEl.value.trim());
		this.renderList();
	}

	private buildItems(query: string): LinkItem[] {
		const items: LinkItem[] = [];
		const qLower = query.toLowerCase();

		// Matching notes (all types, up to 20)
		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			if (items.filter((i) => i.kind === "note").length >= 20) break;
			const name = filenameWithoutExtension(file.name).toLowerCase();
			if (query && !name.includes(qLower)) continue;
			const type = this.manager.getTypeForPath(file.path) ?? undefined;
			items.push({ kind: "note", file, type });
		}

		// Create options when there is no exact-name match
		if (query) {
			const exactMatch = items.some(
				(i) =>
					i.kind === "note" &&
					filenameWithoutExtension(i.file.name).toLowerCase() ===
						qLower
			);
			if (!exactMatch) {
				const types = this.manager
					.getTypes()
					.filter((t) => t.managed !== "daily-notes");
				if (types.length > 0) {
					for (const type of types) {
						items.push({ kind: "create", title: query, type });
					}
				} else {
					items.push({ kind: "create-untyped", title: query });
				}
			}
		}

		return items;
	}

	private renderList(): void {
		this.listEl.empty();

		if (this.items.length === 0) {
			this.listEl.createDiv({
				cls: "obsidian-objects-empty",
				text: "No matching notes",
			});
			return;
		}

		this.items.forEach((item, idx) => {
			const row = this.listEl.createDiv({
				cls:
					"obsidian-objects-selection-link__row" +
					(idx === this.selectedIdx ? " is-selected" : ""),
			});

			row.addEventListener("mouseenter", () => {
				this.selectedIdx = idx;
				this.renderList();
			});
			row.addEventListener("click", () => {
				this.selectedIdx = idx;
				void this.confirmSelection();
			});

			const iconEl = row.createSpan({
				cls: "obsidian-objects-suggest__icon",
			});
			const textEl = row.createDiv({
				cls: "obsidian-objects-suggest__text",
			});
			const titleEl = textEl.createDiv({
				cls: "obsidian-objects-suggest__title",
			});
			const subEl = textEl.createDiv({
				cls: "obsidian-objects-suggest__sub",
			});

			switch (item.kind) {
				case "note":
					setIcon(iconEl, item.type?.icon ?? "file");
					titleEl.setText(filenameWithoutExtension(item.file.name));
					subEl.setText(
						item.type
							? `${item.type.name} · ${item.file.parent?.path ?? ""}`
							: item.file.parent?.path ?? ""
					);
					break;
				case "create":
					setIcon(iconEl, "plus");
					titleEl.setText(`Create "${item.title}"`);
					subEl.setText(`New ${item.type.name}`);
					break;
				case "create-untyped":
					setIcon(iconEl, "plus");
					titleEl.setText(`Create "${item.title}"`);
					subEl.setText("New note");
					break;
			}
		});

		// Scroll the selected row into view
		const selectedRow = this.listEl.children[
			this.selectedIdx
		] as HTMLElement | undefined;
		selectedRow?.scrollIntoView({ block: "nearest" });
	}

	private async confirmSelection(): Promise<void> {
		const item = this.items[this.selectedIdx];
		if (!item) return;

		let file: TFile;
		try {
			switch (item.kind) {
				case "note":
					file = item.file;
					break;
				case "create":
					file = await this.manager.createObjectNote(
						item.type,
						item.title
					);
					new Notice(
						`Created ${item.type.name}: ${filenameWithoutExtension(file.name)}`
					);
					break;
				case "create-untyped": {
					const folder =
						this.app.fileManager.getNewFileParent(
							this.sourcePath
						);
					const folderPath =
						folder.path === "/" ? "" : folder.path;
					const path = uniquePath(
						this.app.vault,
						folderPath,
						item.title
					);
					file = await this.app.vault.create(path, "");
					new Notice(
						`Created note: ${filenameWithoutExtension(file.name)}`
					);
					break;
				}
			}
		} catch (err) {
			console.error(err);
			new Notice(`Could not create note: ${err}`);
			return;
		}

		this.insertLink(file);
		this.close();
	}

	private insertLink(file: TFile): void {
		const linktext = this.app.metadataCache.fileToLinktext(
			file,
			this.sourcePath,
			true
		);
		// The original selected text becomes the display name so the document
		// reads naturally; omit the alias when it matches the link target.
		const alias = this.originalText;
		const wikilink = `[[${linktext}${
			linktext === alias ? "" : `|${alias}`
		}]]`;
		this.editor.replaceRange(wikilink, this.from, this.to);
	}
}
