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
import { ObjectTypeDefinition } from "../types";
import { ObjectTypeManager } from "../objectTypeManager";
import { formatDate, parseNaturalDate } from "../dateParser";
import { filenameWithoutExtension, joinPath } from "../utils";

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
			kind: "daily-note";
			date: Date;
			label: string;
			dailyType: ObjectTypeDefinition | null;
			format: string;
			folder: string;
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
					const { format, folder } = getDailyNotesSettings(
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

		// --- Type rows ---------------------------------------------------
		if (!filter && !implicitType) {
			const qLower = query.toLowerCase();
			for (const t of this.manager.getTypes()) {
				if (t.managed === "daily-notes") continue;
				if (
					qLower.length === 0 ||
					t.name.toLowerCase().includes(qLower) ||
					t.pluralName.toLowerCase().includes(qLower)
				) {
					suggestions.push({
						kind: "type",
						type: t,
						label: t.pluralName,
					});
				}
			}
		}

		// --- Note rows ---------------------------------------------------
		const scopeType: ObjectTypeDefinition | null = filter
			? this.manager.getTypeById(filter.typeId) ?? null
			: implicitType ?? null;
		const notes = findMatchingNotes(this.app, query, scopeType, 20);
		for (const n of notes) {
			suggestions.push({
				kind: "note",
				file: n.file,
				type: n.type,
			});
		}

		// --- Create-new row ---------------------------------------------
		if (scopeType && query.length > 0) {
			const already = notes.some(
				(n) =>
					filenameWithoutExtension(n.file.name).toLowerCase() ===
					query.toLowerCase()
			);
			if (!already) {
				suggestions.push({
					kind: "create",
					type: scopeType,
					title: query,
				});
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
				titleEl.setText(`Create “${suggestion.title}”`);
				subEl.setText(`New ${suggestion.type.name}`);
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
		editor.replaceRange(replacement, start, end);
		const newCh = start.ch + replacement.length;
		editor.setCursor({ line: start.line, ch: newCh });
		this.activeFilter = {
			typeId: type.id,
			prefixLength: `${type.pluralName}/`.length,
		};
		// Re-open the suggester at the new cursor position.
		this.close();
		// Obsidian will reopen the suggester when it detects the trigger on
		// the next input event; forcing a fake space keeps the user's flow.
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

	private async insertDailyNote(
		context: EditorSuggestContext,
		suggestion: Extract<Suggestion, { kind: "daily-note" }>
	): Promise<void> {
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
			this.insertWikilink(context, name, file);
		}
	}
}

// ---------- module-private helpers ----------

function findMatchingNotes(
	app: App,
	query: string,
	scope: ObjectTypeDefinition | null,
	limit: number
): Array<{ file: TFile; type?: ObjectTypeDefinition }> {
	const qLower = query.toLowerCase();
	const results: Array<{ file: TFile; type?: ObjectTypeDefinition }> = [];
	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		if (scope && !file.path.startsWith(scope.folderPath + "/")) continue;
		const name = filenameWithoutExtension(file.name).toLowerCase();
		if (qLower.length > 0 && !name.includes(qLower)) continue;
		results.push({ file, type: scope ?? undefined });
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
