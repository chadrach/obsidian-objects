import { App, Editor, EditorPosition, Notice, TFile, setIcon } from "obsidian";
import { EditorView } from "@codemirror/view";
import { ObjectTypeDefinition } from "../types";
import { ObjectTypeManager } from "../objectTypeManager";
import { formatDate, parseNaturalDate } from "../dateParser";
import { filenameWithoutExtension, joinPath, uniquePath } from "../utils";

type Suggestion =
	| { kind: "type"; type: ObjectTypeDefinition }
	| { kind: "note"; file: TFile; type?: ObjectTypeDefinition }
	| { kind: "create"; type: ObjectTypeDefinition; title: string }
	| { kind: "create-untyped"; title: string }
	| {
			kind: "daily-note";
			date: Date;
			label: string;
			dailyType: ObjectTypeDefinition | null;
			format: string;
			folder: string;
	  };

/**
 * Floating suggestion popup opened when the @ trigger is pressed while text
 * is selected in a CodeMirror (Live Preview) editor.
 *
 * Unlike the regular AtSuggest (EditorSuggest), this component:
 *  - Does NOT insert @ or modify the editor when it opens — the selection
 *    stays in place.
 *  - Carries its own search <input> pre-filled with the selected text.
 *  - Positions itself at the cursor using CM6's coordsAtPos, so it appears
 *    in the same location as the built-in @ suggestion dropdown.
 *  - Supports the same type-filter narrowing as AtSuggest: clicking a type
 *    row prefixes the search input with "Type/" and narrows the note list.
 *  - On pick, replaces the original selection with [[NoteName|selected text]]
 *    so the highlighted text becomes the link display name.
 */
export class SelectionSuggest {
	private popupEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private listEl: HTMLElement | null = null;
	private suggestions: Suggestion[] = [];
	private highlighted = 0;
	private filter: { typeId: string; prefixLength: number } | null = null;

	// Per-session state (set when show() is called, cleared on close)
	private editor: Editor | null = null;
	private from: EditorPosition | null = null;
	private to: EditorPosition | null = null;
	private originalText = "";
	private sourcePath = "";

	private readonly onDocMousedown = (evt: MouseEvent): void => {
		if (this.popupEl && !this.popupEl.contains(evt.target as Node)) {
			this.close();
		}
	};

	constructor(
		private readonly app: App,
		private readonly manager: ObjectTypeManager
	) {}

	show(
		editor: Editor,
		from: EditorPosition,
		to: EditorPosition,
		selectedText: string,
		sourcePath: string,
		cmView: EditorView
	): void {
		this.close();

		this.editor = editor;
		this.from = from;
		this.to = to;
		this.originalText = selectedText;
		this.sourcePath = sourcePath;
		this.filter = null;
		this.highlighted = 0;

		const popup = document.createElement("div");
		popup.addClass("obsidian-objects-mention-popup");
		popup.addClass("obsidian-objects-sel-suggest");

		const input = popup.createEl("input", {
			cls: "obsidian-objects-sel-suggest__input",
			type: "text",
		});
		input.value = selectedText;
		input.setAttribute("placeholder", "Search...");

		const list = popup.createDiv({
			cls: "obsidian-objects-sel-suggest__list",
		});

		input.addEventListener("input", () => {
			this.highlighted = 0;
			this.refresh();
		});
		input.addEventListener("keydown", (evt) => this.handleKeydown(evt));

		this.popupEl = popup;
		this.inputEl = input;
		this.listEl = list;

		document.body.appendChild(popup);
		document.addEventListener("mousedown", this.onDocMousedown, true);

		this.positionPopup(cmView, from);
		this.refresh();

		// Select all text in the input so the user can type to replace it
		// or press Enter immediately to confirm the top suggestion.
		requestAnimationFrame(() => {
			input.focus();
			input.select();
		});
	}

	close(): void {
		if (!this.popupEl) return;
		this.popupEl.remove();
		this.popupEl = null;
		this.inputEl = null;
		this.listEl = null;
		document.removeEventListener("mousedown", this.onDocMousedown, true);
		this.filter = null;
	}

	destroy(): void {
		this.close();
	}

	// ---------- private ----------

	private positionPopup(cmView: EditorView, pos: EditorPosition): void {
		const popup = this.popupEl;
		if (!popup) return;
		try {
			const line = cmView.state.doc.line(pos.line + 1);
			const offset = line.from + Math.min(pos.ch, line.length);
			const coords = cmView.coordsAtPos(offset);
			if (coords) {
				popup.style.position = "fixed";
				popup.style.left = `${Math.max(4, coords.left)}px`;
				popup.style.top = `${coords.bottom + 4}px`;
				return;
			}
		} catch {
			// fall through to safe fallback
		}
		popup.style.position = "fixed";
		popup.style.left = "50%";
		popup.style.top = "30%";
		popup.style.transform = "translateX(-50%)";
	}

	private refresh(): void {
		if (!this.inputEl) return;
		const rawQuery = this.inputEl.value;

		// If the user backspaced past the type-filter prefix, clear the filter.
		if (this.filter) {
			const t = this.manager.getTypeById(this.filter.typeId);
			const prefix = t ? `${t.pluralName}/` : null;
			if (!prefix || !rawQuery.startsWith(prefix)) {
				this.filter = null;
			}
		}

		const query = this.filter
			? rawQuery.slice(this.filter.prefixLength).trim()
			: rawQuery.trim();
		const scopeType = this.filter
			? (this.manager.getTypeById(this.filter.typeId) ?? null)
			: null;

		this.suggestions = this.buildSuggestions(query, scopeType);
		this.highlighted = Math.min(
			this.highlighted,
			Math.max(0, this.suggestions.length - 1)
		);
		this.renderList();
	}

	private buildSuggestions(
		query: string,
		scopeType: ObjectTypeDefinition | null
	): Suggestion[] {
		const items: Suggestion[] = [];
		const qLower = query.toLowerCase();
		const settings = this.manager.getSettings();

		// Daily-note date row (unscoped only, mirrors AtSuggest)
		if (settings.parseNaturalLanguageDates && !scopeType && query.length > 0) {
			const dailyType = this.manager
				.getTypes()
				.find((t) => t.managed === "daily-notes");
			if (dailyType) {
				const parsed = parseNaturalDate(query);
				if (parsed) {
					const opts = getDailyNotesOptions(this.app, dailyType);
					items.push({
						kind: "daily-note",
						date: parsed.date,
						label: parsed.label,
						dailyType,
						format: opts.format,
						folder: opts.folder,
					});
				}
			}
		}

		// Type filter rows (unscoped only)
		if (!scopeType) {
			for (const t of this.manager.getTypes()) {
				if (t.managed === "daily-notes") continue;
				if (
					query.length === 0 ||
					t.name.toLowerCase().includes(qLower) ||
					t.pluralName.toLowerCase().includes(qLower)
				) {
					items.push({ kind: "type", type: t });
				}
			}
		}

		// Note rows (scoped to type folder when filtered, otherwise all)
		const files = this.app.vault.getMarkdownFiles();
		let noteCount = 0;
		for (const file of files) {
			if (noteCount >= 20) break;
			if (scopeType && !file.path.startsWith(scopeType.folderPath + "/"))
				continue;
			const name = filenameWithoutExtension(file.name).toLowerCase();
			if (query && !name.includes(qLower)) continue;
			const fileType =
				scopeType ?? this.manager.getTypeForPath(file.path) ?? undefined;
			items.push({ kind: "note", file, type: fileType });
			noteCount++;
		}

		// Single create row when query has no exact match
		if (query) {
			const exact = items.some(
				(i) =>
					i.kind === "note" &&
					filenameWithoutExtension(i.file.name).toLowerCase() === qLower
			);
			if (!exact) {
				if (scopeType) {
					items.push({ kind: "create", type: scopeType, title: query });
				} else {
					items.push({ kind: "create-untyped", title: query });
				}
			}
		}

		return items;
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();

		if (this.suggestions.length === 0) {
			list.createDiv({
				cls: "obsidian-objects-mention-popup__empty",
				text: "No matches.",
			});
			return;
		}

		this.suggestions.forEach((s, idx) => {
			const row = list.createDiv({
				cls: "obsidian-objects-suggest obsidian-objects-mention-popup__row",
			});
			if (idx === this.highlighted) row.addClass("is-selected");

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

			switch (s.kind) {
				case "type":
					setIcon(iconEl, s.type.icon || "folder");
					titleEl.setText(s.type.pluralName);
					subEl.setText(`Filter to ${s.type.name}`);
					break;
				case "note":
					setIcon(iconEl, s.type?.icon ?? "file");
					titleEl.setText(filenameWithoutExtension(s.file.name));
					subEl.setText(
						s.type
							? `${s.type.name} · ${s.file.parent?.path ?? ""}`
							: s.file.parent?.path ?? ""
					);
					break;
				case "create":
					setIcon(iconEl, "plus");
					titleEl.setText(`Create "${s.title}"`);
					subEl.setText(`New ${s.type.name}`);
					break;
				case "create-untyped":
					setIcon(iconEl, "plus");
					titleEl.setText(`Create "${s.title}"`);
					subEl.setText("New note (default location)");
					break;
				case "daily-note":
					setIcon(iconEl, s.dailyType?.icon ?? "calendar");
					titleEl.setText(formatDate(s.date, s.format));
					subEl.setText(`Daily note · ${s.label}`);
					break;
			}

			row.addEventListener("mouseenter", () => {
				this.highlighted = idx;
				this.renderList();
			});
			// mousedown (not click) so we can preventDefault and keep input focused.
			row.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				void this.selectSuggestion(s);
			});
		});

		const selectedRow = list.children[
			this.highlighted
		] as HTMLElement | undefined;
		selectedRow?.scrollIntoView({ block: "nearest" });
	}

	private handleKeydown(evt: KeyboardEvent): void {
		const count = this.suggestions.length;
		if (evt.key === "ArrowDown") {
			evt.preventDefault();
			this.highlighted = count > 0 ? (this.highlighted + 1) % count : 0;
			this.renderList();
		} else if (evt.key === "ArrowUp") {
			evt.preventDefault();
			this.highlighted =
				count > 0 ? (this.highlighted - 1 + count) % count : 0;
			this.renderList();
		} else if (evt.key === "Enter" || evt.key === "Tab") {
			evt.preventDefault();
			const s = this.suggestions[this.highlighted];
			if (s) void this.selectSuggestion(s);
		} else if (evt.key === "Escape") {
			evt.preventDefault();
			this.close();
		}
	}

	private async selectSuggestion(suggestion: Suggestion): Promise<void> {
		switch (suggestion.kind) {
			case "type":
				this.applyTypeFilter(suggestion.type);
				return;
			case "note":
				this.insertLink(suggestion.file);
				return;
			case "create": {
				try {
					const file = await this.manager.createObjectNote(
						suggestion.type,
						suggestion.title
					);
					new Notice(
						`Created ${suggestion.type.name}: ${filenameWithoutExtension(file.name)}`
					);
					this.insertLink(file);
				} catch (err) {
					new Notice(`Could not create note: ${err}`);
				}
				return;
			}
			case "create-untyped": {
				try {
					const folder =
						this.app.fileManager.getNewFileParent(this.sourcePath);
					const folderPath =
						folder.path === "/" ? "" : folder.path;
					const path = uniquePath(
						this.app.vault,
						folderPath,
						suggestion.title
					);
					const file = await this.app.vault.create(path, "");
					new Notice(
						`Created note: ${filenameWithoutExtension(file.name)}`
					);
					this.insertLink(file);
				} catch (err) {
					new Notice(`Could not create note: ${err}`);
				}
				return;
			}
			case "daily-note": {
				const name = formatDate(suggestion.date, suggestion.format);
				const path = joinPath(suggestion.folder, `${name}.md`);
				let file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) {
					if (suggestion.dailyType) {
						file = await this.manager.createObjectNote(
							suggestion.dailyType,
							name
						);
					} else {
						file = await this.app.vault.create(path, "");
					}
				}
				if (file instanceof TFile) {
					this.insertLink(file);
				}
				return;
			}
		}
	}

	private applyTypeFilter(type: ObjectTypeDefinition): void {
		if (!this.inputEl) return;
		const prefix = `${type.pluralName}/`;
		this.inputEl.value = prefix;
		this.filter = { typeId: type.id, prefixLength: prefix.length };
		this.highlighted = 0;
		this.refresh();
		this.inputEl.focus();
		this.inputEl.setSelectionRange(prefix.length, prefix.length);
	}

	private insertLink(file: TFile): void {
		if (!this.editor || !this.from || !this.to) return;
		const linktext = this.app.metadataCache.fileToLinktext(
			file,
			this.sourcePath,
			true
		);
		// The original selected text becomes the display name so the document
		// reads naturally after the link is inserted. Omit it when it already
		// matches the link target (no redundant alias).
		const alias = this.originalText;
		const wikilink = `[[${linktext}${linktext === alias ? "" : `|${alias}`}]]`;
		this.editor.replaceRange(wikilink, this.from, this.to);
		this.close();
	}
}

function getDailyNotesOptions(
	app: App,
	dailyType: ObjectTypeDefinition
): { format: string; folder: string } {
	const internal = (
		app as unknown as {
			internalPlugins?: {
				getPluginById?: (id: string) => {
					instance?: {
						options?: { format?: string; folder?: string };
					};
				} | null;
			};
		}
	).internalPlugins;
	const opts =
		internal?.getPluginById?.("daily-notes")?.instance?.options ?? {};
	return {
		format: opts.format || "YYYY-MM-DD",
		folder: opts.folder || dailyType.folderPath,
	};
}
