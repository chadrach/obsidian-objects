import { App, Notice, TFile, setIcon } from "obsidian";
import { ObjectTypeDefinition } from "./types";
import { ObjectTypeManager } from "./objectTypeManager";
import { formatDate, parseNaturalDate } from "./dateParser";
import { filenameWithoutExtension, joinPath } from "./utils";

/**
 * `EditorSuggest` only fires inside CodeMirror-managed editors. The
 * Properties editor (the structured frontmatter UI shown above the document
 * in Live Preview / Reading mode) and Bases table cells use plain
 * `<input>`/`contenteditable` elements, so users typing `@` there get
 * nothing. This module attaches a document-level listener that recognises
 * the trigger in those contexts and opens a floating suggestion popup.
 *
 * Behaviour matches the in-editor suggester closely:
 *   - Type-filter narrowing via "<Type>/" prefix.
 *   - Implicit type scoping when the host element identifies a property
 *     known to be linked to a particular object type (Properties editor
 *     rows expose the property name via `data-property-key`; Bases cells
 *     expose it via the column header).
 *   - "Create new <Type>" rows that immediately create a note and insert a
 *     wikilink to it.
 *   - Daily-note rows for natural-language date queries.
 *
 * We deliberately *don't* try to share state with the EditorSuggest — the
 * two are mutually exclusive (CM6 hosts get the EditorSuggest path, every
 * other input gets this popup) and keeping them separate is simpler than
 * generalising one to handle both.
 */
type Suggestion =
	| {
			kind: "type";
			type: ObjectTypeDefinition;
	  }
	| {
			kind: "note";
			file: TFile;
			type?: ObjectTypeDefinition;
	  }
	| {
			kind: "create";
			type: ObjectTypeDefinition;
			title: string;
	  }
	| {
			kind: "daily-note";
			date: Date;
			label: string;
			dailyType: ObjectTypeDefinition | null;
			format: string;
			folder: string;
	  };

interface ActiveSession {
	/** Element that's receiving the user's keystrokes. */
	host: HTMLElement;
	/** Position in the host's text where the trigger character sits. */
	triggerOffset: number;
	/** Active type filter when the user has chosen "<Type>/…". */
	filter: { typeId: string; prefixLength: number } | null;
	/** Implicit type scoping derived from the host's surrounding context. */
	implicitTypeId: string | null;
	/** Most recent rendered suggestions (for keyboard selection). */
	current: Suggestion[];
	/** Highlighted index in `current`. */
	highlighted: number;
	/** Floating element that displays the menu. */
	popupEl: HTMLElement;
	/** Listener bound to `host` so we can detach on close. */
	onInput: (evt: Event) => void;
	/** Listener bound to `host` for keyboard navigation. */
	onKeydown: (evt: KeyboardEvent) => void;
}

export class MentionPopup {
	private session: ActiveSession | null = null;
	private readonly onDocumentInput = (evt: Event) => this.handleInput(evt);
	private readonly onDocumentClick = (evt: MouseEvent) =>
		this.handleOutsideClick(evt);

	constructor(
		private readonly app: App,
		private readonly manager: ObjectTypeManager
	) {}

	attach(): void {
		document.addEventListener("input", this.onDocumentInput, true);
		document.addEventListener("mousedown", this.onDocumentClick, true);
	}

	detach(): void {
		document.removeEventListener("input", this.onDocumentInput, true);
		document.removeEventListener("mousedown", this.onDocumentClick, true);
		this.close();
	}

	// ---------- input plumbing ----------

	private handleInput(evt: Event): void {
		const target = evt.target as HTMLElement | null;
		if (!target) return;

		// Skip CodeMirror-managed inputs — those go through the EditorSuggest.
		if (target.closest(".cm-content")) return;

		// Only operate on real input surfaces.
		if (!isEditableHost(target)) return;

		const trigger = this.manager.getSettings().triggerChar || "@";
		const text = readHostText(target);
		const caret = readHostCaret(target);
		if (caret < 0) return;

		const upTo = text.slice(0, caret);
		const idx = upTo.lastIndexOf(trigger);
		if (idx < 0) {
			this.close();
			return;
		}
		// Trigger must be at start or after whitespace / opening punctuation.
		if (idx > 0 && !/[\s(>[{,;:]/.test(upTo[idx - 1])) {
			this.close();
			return;
		}
		const query = upTo.slice(idx + trigger.length);
		if (/[\n\]]/.test(query)) {
			this.close();
			return;
		}

		this.openOrUpdate(target, idx, query);
	}

	private openOrUpdate(
		host: HTMLElement,
		triggerOffset: number,
		rawQuery: string
	): void {
		if (this.session && this.session.host !== host) {
			this.close();
		}
		if (!this.session) {
			this.session = this.startSession(host, triggerOffset);
		} else {
			this.session.triggerOffset = triggerOffset;
		}
		this.refresh(rawQuery);
	}

	private startSession(
		host: HTMLElement,
		triggerOffset: number
	): ActiveSession {
		const popup = document.createElement("div");
		popup.addClass("obsidian-objects-mention-popup");
		document.body.appendChild(popup);
		const onInput = (evt: Event) => {
			// Re-derive query from the host every input so that we honour
			// caret jumps and out-of-band edits.
			void evt;
			this.handleInput(evt);
		};
		const onKeydown = (evt: KeyboardEvent) =>
			this.handleKeydown(evt);

		host.addEventListener("keydown", onKeydown, true);

		return {
			host,
			triggerOffset,
			filter: null,
			implicitTypeId: detectImplicitType(this.manager, host),
			current: [],
			highlighted: 0,
			popupEl: popup,
			onInput,
			onKeydown,
		};
	}

	private close(): void {
		const session = this.session;
		if (!session) return;
		session.popupEl.remove();
		session.host.removeEventListener(
			"keydown",
			session.onKeydown,
			true
		);
		this.session = null;
	}

	private handleOutsideClick(evt: MouseEvent): void {
		if (!this.session) return;
		const target = evt.target as Node | null;
		if (!target) return;
		if (
			!this.session.popupEl.contains(target) &&
			!this.session.host.contains(target)
		) {
			this.close();
		}
	}

	private handleKeydown(evt: KeyboardEvent): void {
		const session = this.session;
		if (!session) return;
		if (session.current.length === 0) {
			if (evt.key === "Escape") {
				this.close();
			}
			return;
		}
		if (evt.key === "ArrowDown") {
			evt.preventDefault();
			session.highlighted =
				(session.highlighted + 1) % session.current.length;
			this.renderSuggestions();
		} else if (evt.key === "ArrowUp") {
			evt.preventDefault();
			session.highlighted =
				(session.highlighted - 1 + session.current.length) %
				session.current.length;
			this.renderSuggestions();
		} else if (evt.key === "Enter" || evt.key === "Tab") {
			evt.preventDefault();
			evt.stopPropagation();
			void this.selectSuggestion(
				session.current[session.highlighted]
			);
		} else if (evt.key === "Escape") {
			evt.preventDefault();
			this.close();
		}
	}

	// ---------- suggestion building ----------

	private refresh(rawQuery: string): void {
		const session = this.session;
		if (!session) return;

		const filter = session.filter;
		const filterType = filter
			? this.manager.getTypeById(filter.typeId)
			: null;
		const expectedFilterPrefix = filterType
			? `${filterType.pluralName}/`
			: null;
		if (
			expectedFilterPrefix &&
			!rawQuery.startsWith(expectedFilterPrefix)
		) {
			session.filter = null;
		}
		const activeFilter = session.filter;
		const query = activeFilter
			? rawQuery.slice(activeFilter.prefixLength).trim()
			: rawQuery.trim();

		const suggestions: Suggestion[] = [];
		const settings = this.manager.getSettings();

		const implicitType =
			!activeFilter && session.implicitTypeId
				? this.manager.getTypeById(session.implicitTypeId)
				: null;

		if (settings.parseNaturalLanguageDates && !activeFilter) {
			const dailyType = this.manager
				.getTypes()
				.find((t) => t.managed === "daily-notes");
			if (dailyType && query.length > 0) {
				const parsed = parseNaturalDate(query);
				if (parsed) {
					const { format, folder } = readDailyNotesOptions(
						this.app,
						dailyType
					);
					suggestions.push({
						kind: "daily-note",
						date: parsed.date,
						label: parsed.label,
						dailyType,
						format,
						folder,
					});
				}
			}
		}

		if (!activeFilter && !implicitType) {
			const qLower = query.toLowerCase();
			for (const t of this.manager.getTypes()) {
				if (t.managed === "daily-notes") continue;
				if (
					qLower.length === 0 ||
					t.name.toLowerCase().includes(qLower) ||
					t.pluralName.toLowerCase().includes(qLower)
				) {
					suggestions.push({ kind: "type", type: t });
				}
			}
		}

		const scope: ObjectTypeDefinition | null = activeFilter
			? this.manager.getTypeById(activeFilter.typeId) ?? null
			: implicitType ?? null;
		const notes = findMatchingNotes(this.app, query, scope, 20);
		for (const n of notes) {
			suggestions.push({ kind: "note", file: n.file, type: n.type });
		}
		if (scope && query.length > 0) {
			const exists = notes.some(
				(n) =>
					filenameWithoutExtension(n.file.name).toLowerCase() ===
					query.toLowerCase()
			);
			if (!exists) {
				suggestions.push({
					kind: "create",
					type: scope,
					title: query,
				});
			}
		}

		session.current = suggestions;
		session.highlighted = Math.min(
			session.highlighted,
			Math.max(0, suggestions.length - 1)
		);
		this.renderSuggestions();
		this.positionPopup();
	}

	private renderSuggestions(): void {
		const session = this.session;
		if (!session) return;
		session.popupEl.empty();
		if (session.current.length === 0) {
			session.popupEl.createDiv({
				cls: "obsidian-objects-mention-popup__empty",
				text: "No matches.",
			});
			return;
		}
		session.current.forEach((suggestion, idx) => {
			const row = session.popupEl.createDiv({
				cls: "obsidian-objects-suggest obsidian-objects-mention-popup__row",
			});
			if (idx === session.highlighted) {
				row.addClass("is-selected");
			}
			const iconEl = row.createSpan({
				cls: "obsidian-objects-suggest__icon",
			});
			const text = row.createDiv({
				cls: "obsidian-objects-suggest__text",
			});
			const title = text.createDiv({
				cls: "obsidian-objects-suggest__title",
			});
			const sub = text.createDiv({
				cls: "obsidian-objects-suggest__sub",
			});
			switch (suggestion.kind) {
				case "type":
					setIcon(iconEl, suggestion.type.icon || "folder");
					title.setText(suggestion.type.pluralName);
					sub.setText(`Filter to ${suggestion.type.name}`);
					break;
				case "note":
					setIcon(iconEl, suggestion.type?.icon ?? "file");
					title.setText(
						filenameWithoutExtension(suggestion.file.name)
					);
					sub.setText(
						suggestion.type
							? `${suggestion.type.name} · ${
									suggestion.file.parent?.path ?? ""
								}`
							: suggestion.file.parent?.path ?? ""
					);
					break;
				case "create":
					setIcon(iconEl, "plus");
					title.setText(`Create “${suggestion.title}”`);
					sub.setText(`New ${suggestion.type.name}`);
					break;
				case "daily-note":
					setIcon(
						iconEl,
						suggestion.dailyType?.icon ?? "calendar"
					);
					title.setText(
						formatDate(suggestion.date, suggestion.format)
					);
					sub.setText(`Daily note · ${suggestion.label}`);
					break;
			}
			row.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				void this.selectSuggestion(suggestion);
			});
		});
	}

	private positionPopup(): void {
		const session = this.session;
		if (!session) return;
		const rect = session.host.getBoundingClientRect();
		session.popupEl.style.top = `${rect.bottom + 4 + window.scrollY}px`;
		session.popupEl.style.left = `${rect.left + window.scrollX}px`;
		session.popupEl.style.minWidth = `${Math.max(
			rect.width,
			220
		)}px`;
	}

	// ---------- actions ----------

	private async selectSuggestion(suggestion: Suggestion): Promise<void> {
		const session = this.session;
		if (!session) return;

		switch (suggestion.kind) {
			case "type":
				this.applyTypeFilter(suggestion.type);
				return;
			case "note":
				this.insertWikilink(
					filenameWithoutExtension(suggestion.file.name),
					suggestion.file
				);
				return;
			case "create":
				try {
					const file = await this.manager.createObjectNote(
						suggestion.type,
						suggestion.title
					);
					this.insertWikilink(
						filenameWithoutExtension(file.name),
						file
					);
					new Notice(
						`Created ${suggestion.type.name}: ${filenameWithoutExtension(
							file.name
						)}`
					);
				} catch (err) {
					new Notice(`Could not create note: ${err}`);
				}
				return;
			case "daily-note": {
				const name = formatDate(
					suggestion.date,
					suggestion.format
				);
				const path = joinPath(suggestion.folder, `${name}.md`);
				let file =
					this.app.vault.getAbstractFileByPath(path);
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
					this.insertWikilink(name, file);
				}
				return;
			}
		}
	}

	private applyTypeFilter(type: ObjectTypeDefinition): void {
		const session = this.session;
		if (!session) return;
		const trigger = this.manager.getSettings().triggerChar || "@";
		const replacement = `${trigger}${type.pluralName}/`;
		const text = readHostText(session.host);
		const caret = readHostCaret(session.host);
		const before = text.slice(0, session.triggerOffset);
		const after = text.slice(caret);
		writeHostText(
			session.host,
			before + replacement + after,
			before.length + replacement.length
		);
		session.filter = {
			typeId: type.id,
			prefixLength: `${type.pluralName}/`.length,
		};
		this.refresh(replacement.slice(trigger.length));
	}

	private insertWikilink(displayName: string, file: TFile): void {
		const session = this.session;
		if (!session) return;
		const linktext = this.app.metadataCache.fileToLinktext(
			file,
			"",
			true
		);
		const wikilink = `[[${linktext}${
			linktext === displayName ? "" : `|${displayName}`
		}]]`;
		// Inside the Properties editor we want to insert just the link text,
		// no brackets, since Obsidian renders a link from a bare value. Bases
		// cells behave the same. Use the file's basename so the value is the
		// linktext that the property editor will resolve.
		const insertion = isPropertyValueHost(session.host)
			? linktext
			: wikilink;

		const text = readHostText(session.host);
		const caret = readHostCaret(session.host);
		const before = text.slice(0, session.triggerOffset);
		const after = text.slice(caret);
		writeHostText(
			session.host,
			before + insertion + after,
			before.length + insertion.length
		);
		this.close();
	}
}

// ---------- module-private helpers ----------

function isEditableHost(el: HTMLElement): boolean {
	if (
		el instanceof HTMLInputElement &&
		(el.type === "text" || el.type === "search" || el.type === "")
	) {
		return true;
	}
	if (el instanceof HTMLTextAreaElement) return true;
	if (el.isContentEditable) return true;
	return false;
}

function readHostText(host: HTMLElement): string {
	if (
		host instanceof HTMLInputElement ||
		host instanceof HTMLTextAreaElement
	) {
		return host.value;
	}
	return host.innerText ?? host.textContent ?? "";
}

function readHostCaret(host: HTMLElement): number {
	if (
		host instanceof HTMLInputElement ||
		host instanceof HTMLTextAreaElement
	) {
		return host.selectionStart ?? host.value.length;
	}
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return -1;
	const range = sel.getRangeAt(0);
	if (!host.contains(range.endContainer)) return -1;
	const pre = range.cloneRange();
	pre.selectNodeContents(host);
	pre.setEnd(range.endContainer, range.endOffset);
	return pre.toString().length;
}

function writeHostText(
	host: HTMLElement,
	value: string,
	caret: number
): void {
	if (
		host instanceof HTMLInputElement ||
		host instanceof HTMLTextAreaElement
	) {
		host.value = value;
		host.setSelectionRange(caret, caret);
		host.dispatchEvent(new Event("input", { bubbles: true }));
		host.dispatchEvent(new Event("change", { bubbles: true }));
		return;
	}
	host.textContent = value;
	const range = document.createRange();
	const node = host.firstChild ?? host;
	const offset = Math.min(caret, value.length);
	if (node.nodeType === Node.TEXT_NODE) {
		range.setStart(node, offset);
	} else {
		range.setStart(host, 0);
	}
	range.collapse(true);
	const sel = window.getSelection();
	sel?.removeAllRanges();
	sel?.addRange(range);
	host.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

/**
 * In the Properties editor and in Bases table cells, the value being edited
 * is intended as a property value, not raw markdown. Inserting brackets
 * would write the literal `[[…]]` to frontmatter rather than producing a
 * link, so we insert the link text only.
 */
function isPropertyValueHost(host: HTMLElement): boolean {
	if (host.closest(".metadata-property")) return true;
	if (host.closest(".metadata-properties")) return true;
	if (host.closest(".bases-rendered-cell")) return true;
	if (host.closest(".bases-table")) return true;
	if (host.closest(".bases-tr")) return true;
	return false;
}

function detectImplicitType(
	manager: ObjectTypeManager,
	host: HTMLElement
): string | null {
	// Properties editor row: `data-property-key` carries the property name,
	// and the file path can be inferred from the surrounding leaf.
	const propertyEl = host.closest(
		".metadata-property"
	) as HTMLElement | null;
	const propertyKey =
		propertyEl?.dataset.propertyKey ??
		(host.closest("[data-property-key]") as HTMLElement | null)?.dataset
			.propertyKey;
	const filePath = findOwningFilePath(host);
	if (propertyKey && filePath) {
		const fileType = manager.getTypeForPath(filePath);
		if (fileType) {
			const prop = manager
				.getEffectiveProperties(fileType)
				.find(
					(p) => p.name.toLowerCase() === propertyKey.toLowerCase()
				);
			if (prop?.linkedTypeId) return prop.linkedTypeId;
		}
	}

	// Bases cell: the column header carries the property name, and the
	// row carries the file path. Bases markup varies by version, so we
	// look for a few common attribute names.
	const baseCell = host.closest(
		".bases-rendered-cell, .bases-cell, [data-bases-property]"
	) as HTMLElement | null;
	if (baseCell) {
		const propName =
			baseCell.dataset.basesProperty ??
			baseCell.dataset.property ??
			columnHeaderForCell(baseCell);
		const rowPath = baseCell
			.closest("[data-row-path], [data-file-path]")
			?.getAttribute("data-row-path") ??
			(baseCell.closest("[data-row-path], [data-file-path]") as HTMLElement | null)?.dataset
				.filePath;
		if (propName) {
			// We may not know a specific file's type from the row, but we can
			// look up any type that defines a linked property with this name
			// and bias toward that.
			for (const t of manager.getTypes()) {
				const prop = manager
					.getEffectiveProperties(t)
					.find(
						(p) =>
							p.name.toLowerCase() === propName.toLowerCase()
					);
				if (prop?.linkedTypeId) return prop.linkedTypeId;
			}
			void rowPath;
		}
	}
	return null;
}

function columnHeaderForCell(cell: HTMLElement): string | null {
	const headers = cell
		.closest(".bases-table, table")
		?.querySelectorAll(
			"th, .bases-th, [data-bases-property]"
		);
	if (!headers) return null;
	const cellIndex = Array.from(
		cell.parentElement?.children ?? []
	).indexOf(cell);
	const header = cellIndex >= 0 ? headers[cellIndex] : null;
	if (!header) return null;
	return (
		(header as HTMLElement).dataset.basesProperty ??
		(header as HTMLElement).innerText.trim() ??
		null
	);
}

function findOwningFilePath(host: HTMLElement): string | null {
	const view = host.closest(".workspace-leaf-content") as HTMLElement | null;
	const path = view?.getAttribute("data-path");
	return path ?? null;
}

function findMatchingNotes(
	app: App,
	query: string,
	scope: ObjectTypeDefinition | null,
	limit: number
): Array<{ file: TFile; type?: ObjectTypeDefinition }> {
	const qLower = query.toLowerCase();
	const out: Array<{ file: TFile; type?: ObjectTypeDefinition }> = [];
	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		if (scope && !file.path.startsWith(scope.folderPath + "/")) continue;
		const name = filenameWithoutExtension(file.name).toLowerCase();
		if (qLower.length > 0 && !name.includes(qLower)) continue;
		out.push({ file, type: scope ?? undefined });
		if (out.length >= limit) break;
	}
	return out;
}

function readDailyNotesOptions(
	app: App,
	dailyType: ObjectTypeDefinition
): { format: string; folder: string } {
	const internal = (app as unknown as {
		internalPlugins?: {
			getPluginById?: (id: string) => {
				instance?: { options?: { format?: string; folder?: string } };
			} | null;
		};
	}).internalPlugins;
	const opts =
		internal?.getPluginById?.("daily-notes")?.instance?.options ?? {};
	return {
		format: opts.format || "YYYY-MM-DD",
		folder: opts.folder || dailyType.folderPath,
	};
}
