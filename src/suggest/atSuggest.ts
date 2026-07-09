import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	Notice,
	TFile,
	setIcon,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { ObjectTypeDefinition } from "../types";
import { ObjectTypeManager } from "../objectTypeManager";
import { formatDate, parseNaturalDate } from "../dateParser";
import { filenameWithoutExtension, joinPath, uniquePath } from "../utils";

type Suggestion =
	| {
			kind: "type";
			type: ObjectTypeDefinition;
			label: string;
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
			kind: "create-untyped";
			title: string;
	  }
	| {
			kind: "daily-note";
			date: Date;
			label: string;
			dailyType: ObjectTypeDefinition | null;
			format: string;
			folder: string;
			templatePath: string;
	  };

interface ActiveFilter {
	typeId: string;
	/** Length of the prefix (including separator) already typed for this filter. */
	prefixLength: number;
}

/**
 * `EditorSuggest` implementation that mimics Obsidian's built-in link picker
 * but is keyed on a single trigger character (default `@`) and is aware of
 * object types.
 *
 * UX walkthrough (for the non-obvious parts):
 *  - Typing `@` opens the popup in "root" mode: all types + notes are mixed.
 *  - If the user types text that matches a type name, that type appears as a
 *    selectable row. Selecting it *does not* insert anything — instead we
 *    mark it as the active filter and reopen the popup narrowed to that type.
 *    The trigger text gets a `{Type}/` prefix so backspace still works.
 *  - While a filter is active, if the remaining query does not match an
 *    existing note we offer a "Create new {Type} …" row.
 *  - If Daily Notes is registered as a managed type, the query is also parsed
 *    as a natural-language date and offered as a first-class suggestion.
 *
 * When text is selected in the editor and the trigger is pressed, the plugin's
 * keydown handler intercepts the event entirely (preventDefault) and opens
 * SelectionLinkModal instead — so this class only handles the no-selection case.
 */
export class AtSuggest extends EditorSuggest<Suggestion> {
	private activeFilter: ActiveFilter | null = null;
	/**
	 * When a link is being composed inside a frontmatter property that is
	 * linked to a specific object type, this is that type's id. Populated on
	 * trigger by inspecting the line above the cursor.
	 */
	private propertyContextTypeId: string | null = null;

	constructor(app: App, private readonly manager: ObjectTypeManager) {
		super(app);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile | null
	): EditorSuggestTriggerInfo | null {
		const trigger = this.manager.getSettings().triggerChar || "@";
		const line = editor.getLine(cursor.line);
		const upTo = line.slice(0, cursor.ch);
		const idx = upTo.lastIndexOf(trigger);
		if (idx < 0) return null;

		// The trigger must be at line start or preceded by whitespace / an
		// opening bracket so we don't hijack email addresses.
		if (idx > 0) {
			const prev = upTo[idx - 1];
			if (!/[\s(>[{,;:]/.test(prev)) return null;
		}

		const query = upTo.slice(idx + trigger.length);
		// Don't trigger on closing-bracket sequences or newlines.
		if (/[\]\n]/.test(query)) return null;

		this.propertyContextTypeId = detectPropertyLinkedType(
			this.manager,
			editor,
			cursor,
			file
		);

		return {
			start: { line: cursor.line, ch: idx },
			end: cursor,
			query,
		};
	}

	getSuggestions(context: EditorSuggestContext): Suggestion[] {
		const raw = context.query;
		const filter = this.resolveActiveFilter(raw);
		const query = filter
			? raw.slice(filter.prefixLength).trim()
			: raw.trim();
		const settings = this.manager.getSettings();
		const suggestions: Suggestion[] = [];

		// Property-context filter: if the user is editing a linked property we
		// implicitly scope to the target type (unless they've already chosen
		// a different one explicitly).
		const implicitTypeId = !filter ? this.propertyContextTypeId : null;
		const implicitType = implicitTypeId
			? this.manager.getTypeById(implicitTypeId)
			: null;

		// --- Daily-note date suggestion -----------------------------------
		if (settings.parseNaturalLanguageDates && !filter) {
			const dailyType = this.manager
				.getTypes()
				.find((t) => t.managed === "daily-notes");
			if (dailyType && query.length > 0) {
				const parsed = parseNaturalDate(query);
				if (parsed) {
					const { format, folder, templatePath } = getDailyNotesSettings(
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
						templatePath,
					});
				}
			}
		}

		// --- Note rows ---------------------------------------------------
		// Most-recently-modified first (matches Quick Switcher), limit 10.
		const scopeType: ObjectTypeDefinition | null = filter
			? this.manager.getTypeById(filter.typeId) ?? null
			: implicitType ?? null;
		const notes = findMatchingNotes(
			this.app,
			this.manager,
			query,
			scopeType,
			10
		);
		const noteSuggestions = notes.map((n) => ({
			kind: "note" as const,
			file: n.file,
			type: n.type,
		}));

		// --- Type rows ---------------------------------------------------
		// Build type matches independently so we can decide their position:
		// when the query is non-empty and matches at least one type name,
		// types appear before notes (the user is clearly looking for a type).
		// When the query is empty, types trail notes so the list opens with
		// recent notes rather than a wall of type filters.
		const typeSuggestions: Extract<Suggestion, { kind: "type" }>[] = [];
		if (!filter && !implicitType) {
			const qLower = query.toLowerCase();
			for (const t of this.manager.getTypes()) {
				if (t.managed === "daily-notes") continue;
				if (
					qLower.length === 0 ||
					t.name.toLowerCase().includes(qLower) ||
					t.pluralName.toLowerCase().includes(qLower)
				) {
					typeSuggestions.push({
						kind: "type",
						type: t,
						label: t.pluralName,
					});
				}
			}
		}

		const typesMatchQuery = query.length > 0 && typeSuggestions.length > 0;
		if (typesMatchQuery) {
			suggestions.push(...typeSuggestions, ...noteSuggestions);
		} else {
			suggestions.push(...noteSuggestions, ...typeSuggestions);
		}

		// --- Create-new row ---------------------------------------------
		if (query.length > 0) {
			const already = notes.some(
				(n) =>
					filenameWithoutExtension(n.file.name).toLowerCase() ===
					query.toLowerCase()
			);
			if (!already) {
				if (scopeType) {
					suggestions.push({
						kind: "create",
						type: scopeType,
						title: query,
					});
				} else {
					// No type chosen — offer to create a plain note in the
					// vault's default location (Files & Links → New note
					// location). Without this, the dropdown would close on
					// any unknown name and lock the user out of creation.
					suggestions.push({
						kind: "create-untyped",
						title: query,
					});
				}
			}
		}

		return suggestions;
	}

	renderSuggestion(suggestion: Suggestion, el: HTMLElement): void {
		el.addClass("obsidian-objects-suggest");
		const iconEl = el.createSpan({ cls: "obsidian-objects-suggest__icon" });
		const textEl = el.createDiv({ cls: "obsidian-objects-suggest__text" });
		const titleEl = textEl.createDiv({
			cls: "obsidian-objects-suggest__title",
		});
		const subEl = textEl.createDiv({
			cls: "obsidian-objects-suggest__sub",
		});

		switch (suggestion.kind) {
			case "type": {
				setIcon(iconEl, suggestion.type.icon || "folder");
				titleEl.setText(suggestion.type.pluralName);
				subEl.setText(`Filter to ${suggestion.type.name}`);
				break;
			}
			case "note": {
				const icon = suggestion.type?.icon ?? "file";
				setIcon(iconEl, icon);
				titleEl.setText(
					filenameWithoutExtension(suggestion.file.name)
				);
				subEl.setText(
					suggestion.type
						? `${suggestion.type.name} · ${suggestion.file.parent?.path ?? ""}`
						: suggestion.file.parent?.path ?? ""
				);
				break;
			}
			case "create": {
				setIcon(iconEl, "plus");
				titleEl.setText(`Create "${suggestion.title}"`);
				subEl.setText(`New ${suggestion.type.name}`);
				break;
			}
			case "create-untyped": {
				setIcon(iconEl, "plus");
				titleEl.setText(`Create "${suggestion.title}"`);
				subEl.setText("New note (default location)");
				break;
			}
			case "daily-note": {
				setIcon(iconEl, suggestion.dailyType?.icon ?? "calendar");
				const name = formatDate(suggestion.date, suggestion.format);
				titleEl.setText(name);
				subEl.setText(`Daily note · ${suggestion.label}`);
				break;
			}
		}
	}

	selectSuggestion(
		suggestion: Suggestion,
		_evt: MouseEvent | KeyboardEvent
	): void {
		const context = this.context;
		if (!context) return;

		switch (suggestion.kind) {
			case "type":
				this.applyTypeFilter(context, suggestion.type);
				return;
			case "note":
				this.insertWikilink(
					context,
					filenameWithoutExtension(suggestion.file.name),
					suggestion.file
				);
				return;
			case "create":
				void this.createAndInsert(context, suggestion);
				return;
			case "create-untyped":
				void this.createUntypedAndInsert(context, suggestion);
				return;
			case "daily-note":
				void this.insertDailyNote(context, suggestion);
				return;
		}
	}

	// ---------- helpers ----------

	private resolveActiveFilter(rawQuery: string): ActiveFilter | null {
		const filter = this.activeFilter;
		if (!filter) return null;
		const type = this.manager.getTypeById(filter.typeId);
		if (!type) {
			this.activeFilter = null;
			return null;
		}
		const expected = `${type.pluralName}/`;
		if (!rawQuery.startsWith(expected)) {
			this.activeFilter = null;
			return null;
		}
		return { typeId: filter.typeId, prefixLength: expected.length };
	}

	private applyTypeFilter(
		context: EditorSuggestContext,
		type: ObjectTypeDefinition
	): void {
		const { editor, start, end } = context;
		const trigger = this.manager.getSettings().triggerChar || "@";
		const replacement = `${trigger}${type.pluralName}/`;
		// Set activeFilter before the dispatch so getSuggestions sees it
		// immediately when the EditorSuggest re-evaluates on the same frame.
		this.activeFilter = {
			typeId: type.id,
			prefixLength: `${type.pluralName}/`.length,
		};
		const cmView = (editor as unknown as { cm?: EditorView }).cm;
		if (cmView) {
			// Dispatch as "input.type" so Obsidian's EditorSuggest bridge
			// re-triggers onTrigger and updates the popup in-place, showing
			// the 10 most-recent notes for this type without closing first.
			const from = cmView.state.doc.line(start.line + 1).from + start.ch;
			const to = cmView.state.doc.line(end.line + 1).from + end.ch;
			cmView.dispatch({
				changes: { from, to, insert: replacement },
				selection: { anchor: from + replacement.length },
				userEvent: "input.type",
			});
		} else {
			editor.replaceRange(replacement, start, end);
			editor.setCursor({ line: start.line, ch: start.ch + replacement.length });
			this.close();
		}
	}

	private insertWikilink(
		context: EditorSuggestContext,
		displayName: string,
		file: TFile
	): void {
		const linktext = this.app.metadataCache.fileToLinktext(
			file,
			context.file?.path ?? "",
			true
		);
		const replacement = `[[${linktext}${
			linktext === displayName ? "" : `|${displayName}`
		}]]`;
		context.editor.replaceRange(
			replacement,
			context.start,
			context.end
		);
		this.activeFilter = null;
	}

	private async createAndInsert(
		context: EditorSuggestContext,
		suggestion: Extract<Suggestion, { kind: "create" }>
	): Promise<void> {
		try {
			const file = await this.manager.createObjectNote(
				suggestion.type,
				suggestion.title
			);
			this.insertWikilink(context, suggestion.title, file);
			new Notice(
				`Created ${suggestion.type.name}: ${filenameWithoutExtension(
					file.name
				)}`
			);
		} catch (err) {
			console.error(err);
			new Notice(`Could not create ${suggestion.type.name}: ${err}`);
		}
	}

	private async createUntypedAndInsert(
		context: EditorSuggestContext,
		suggestion: Extract<Suggestion, { kind: "create-untyped" }>
	): Promise<void> {
		try {
			// `getNewFileParent` honours the user's "Default location for new
			// notes" setting (Files & Links). Falls back to the vault root
			// when set to "current" with no active file.
			const sourcePath = context.file?.path ?? "";
			const folder = this.app.fileManager.getNewFileParent(sourcePath);
			const folderPath = folder.path === "/" ? "" : folder.path;
			const path = uniquePath(
				this.app.vault,
				folderPath,
				suggestion.title
			);
			const file = await this.app.vault.create(path, "");
			this.insertWikilink(
				context,
				filenameWithoutExtension(file.name),
				file
			);
			new Notice(`Created note: ${filenameWithoutExtension(file.name)}`);
		} catch (err) {
			console.error(err);
			new Notice(`Could not create note: ${err}`);
		}
	}

	private async insertDailyNote(
		context: EditorSuggestContext,
		suggestion: Extract<Suggestion, { kind: "daily-note" }>
	): Promise<void> {
		const name = formatDate(suggestion.date, suggestion.format);
		const targetPath = joinPath(suggestion.folder, `${name}.md`);
		let file = this.app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile)) {
			file = await this.manager.createDailyNote(
				suggestion.dailyType,
				name,
				suggestion.date,
				suggestion.templatePath,
				targetPath
			);
		}
		if (file instanceof TFile) {
			this.insertWikilink(context, name, file);
		}
	}
}

// ---------- module-private helpers ----------

function findMatchingNotes(
	app: App,
	manager: ObjectTypeManager,
	query: string,
	scope: ObjectTypeDefinition | null,
	limit: number
): Array<{ file: TFile; type?: ObjectTypeDefinition }> {
	const qLower = query.toLowerCase();
	const results: Array<{ file: TFile; type?: ObjectTypeDefinition }> = [];
	// Sort by most-recently-modified first, matching Obsidian's Quick Switcher.
	const files = app.vault.getMarkdownFiles().slice().sort(
		(a, b) => b.stat.mtime - a.stat.mtime
	);
	for (const file of files) {
		if (scope && !file.path.startsWith(scope.folderPath + "/")) continue;
		const name = filenameWithoutExtension(file.name).toLowerCase();
		if (qLower.length > 0 && !name.includes(qLower)) continue;
		// When unscoped, look up each match's actual type so the dropdown
		// shows the correct icon (Person → user icon, etc.) instead of the
		// generic file icon.
		const fileType =
			scope ?? manager.getTypeForPath(file.path) ?? undefined;
		results.push({ file, type: fileType });
		if (results.length >= limit) break;
	}
	return results;
}

/**
 * If the cursor is positioned on a frontmatter line whose key matches a
 * linked property on the current note's object type, return the target
 * type id so the @ menu can implicitly scope its results.
 */
function detectPropertyLinkedType(
	manager: ObjectTypeManager,
	editor: Editor,
	cursor: EditorPosition,
	file: TFile | null
): string | null {
	if (!file) return null;
	// Walk upward to find frontmatter boundaries and the active property key.
	let inFrontmatter = false;
	let propertyName: string | null = null;
	for (let l = cursor.line; l >= 0; l -= 1) {
		const text = editor.getLine(l);
		if (l === cursor.line) {
			const m = text.match(/^([A-Za-z0-9_\- ]+):/);
			if (m) propertyName = m[1].trim();
		}
		if (text.trim() === "---") {
			inFrontmatter = l !== cursor.line;
			break;
		}
	}
	if (!inFrontmatter || !propertyName) return null;

	const typeForFile = manager.getTypeForPath(file.path);
	if (!typeForFile) return null;
	const prop = manager
		.getEffectiveProperties(typeForFile)
		.find((p) => p.name.toLowerCase() === propertyName!.toLowerCase());
	return prop?.linkedTypeId ?? null;
}

function getDailyNotesSettings(
	app: App,
	dailyType: ObjectTypeDefinition
): { format: string; folder: string; templatePath: string } {
	const internal = (app as unknown as {
		internalPlugins?: {
			getPluginById?: (id: string) => {
				instance?: {
					options?: {
						format?: string;
						folder?: string;
						template?: string;
					};
				} | null;
			} | null;
		};
	}).internalPlugins;
	const opts =
		internal?.getPluginById?.("daily-notes")?.instance?.options ?? {};
	return {
		format: opts.format?.trim() || "YYYY-MM-DD",
		folder: opts.folder?.trim() || dailyType.folderPath,
		templatePath: opts.template?.trim() || "",
	};
}
