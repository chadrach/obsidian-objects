import { App, TFile } from "obsidian";
import yaml from "js-yaml";
import { ObjectProperty, ObjectTypeDefinition } from "./types";
import type { ObjectTypeManager } from "./objectTypeManager";

/**
 * Generate or update the `.base` file backing an object type.
 *
 * Bases requires a specific schema (see https://help.obsidian.md/bases/syntax):
 *
 *   filters:
 *     and:
 *       - file.inFolder("People")
 *   properties:
 *     Company:
 *       displayName: Company
 *   views:
 *     - type: table
 *       name: All People
 *       order:
 *         - file.name
 *         - Company
 *
 * Emitting `properties` as a YAML list (as the first version did) produces an
 * "invalid properties configuration" error in the Bases parser.
 *
 * On *update* we don't overwrite the file: we parse the existing YAML, mutate
 * only the entries we own (the folder filter, the properties map, and the
 * generated default view's order list), and write back. That preserves any
 * additional views, formulas, group_by, summaries, or column settings the
 * user has added inside the Bases UI.
 */

const GENERATED_VIEW_NAME_PREFIX = "All ";

interface PropertyMutation {
	added: ObjectProperty[];
	removed: { id: string; name: string }[];
	renamed: { id: string; from: string; to: string }[];
}

interface BaseDoc {
	filters?: BaseFilter;
	properties?: Record<string, BasePropertyEntry>;
	formulas?: Record<string, string>;
	summaries?: Record<string, string>;
	views?: BaseView[];
	[key: string]: unknown;
}

interface BaseFilter {
	and?: Array<string | BaseFilter>;
	or?: Array<string | BaseFilter>;
	not?: Array<string | BaseFilter>;
	[key: string]: unknown;
}

interface BasePropertyEntry {
	displayName?: string;
	[key: string]: unknown;
}

interface BaseView {
	type?: string;
	name?: string;
	order?: string[];
	filters?: BaseFilter;
	[key: string]: unknown;
}

export async function writeBaseFile(
	app: App,
	type: ObjectTypeDefinition,
	manager: ObjectTypeManager,
	mutation?: PropertyMutation
): Promise<void> {
	const path = type.basePath;
	const existing = app.vault.getAbstractFileByPath(path);
	const properties = manager.getEffectiveProperties(type);

	if (existing instanceof TFile) {
		const current = await app.vault.read(existing);
		const updated = updateExistingBase(current, type, properties, mutation);
		if (updated !== current) {
			await app.vault.modify(existing, updated);
		}
		return;
	}

	const fresh = buildFreshBase(type, properties);
	await app.vault.create(path, fresh);
}

/**
 * First-time creation: emit a complete, opinionated default base.
 */
function buildFreshBase(
	type: ObjectTypeDefinition,
	properties: ObjectProperty[]
): string {
	const doc: BaseDoc = {
		filters: {
			and: [`file.inFolder("${escapeForFilterArg(type.folderPath)}")`],
		},
		properties: {},
		views: [
			{
				type: "table",
				name: `${GENERATED_VIEW_NAME_PREFIX}${type.pluralName}`,
				order: ["file.name", ...properties.map((p) => p.name)],
			},
		],
	};
	for (const p of properties) {
		(doc.properties as Record<string, BasePropertyEntry>)[p.name] = {
			displayName: p.name,
		};
	}
	const banner =
		"# Managed by Obsidian Objects. Re-generated whenever the type changes.\n" +
		"# You can freely edit views, add formulas, change column widths, etc.\n" +
		"# The plugin only modifies the auto-generated default view's order\n" +
		"# and the top-level properties map when type properties change.\n";
	return banner + dumpYaml(doc);
}

/**
 * Subsequent updates: parse + surgical edit. Falls back to a fresh write if
 * the existing file is unparseable.
 */
function updateExistingBase(
	current: string,
	type: ObjectTypeDefinition,
	properties: ObjectProperty[],
	mutation: PropertyMutation | undefined
): string {
	const { banner, body } = splitBanner(current);
	let parsed: BaseDoc;
	try {
		parsed = (yaml.load(body) as BaseDoc | null) ?? {};
	} catch (err) {
		console.warn(
			"Existing .base file is invalid YAML, regenerating from scratch.",
			err
		);
		return buildFreshBase(type, properties);
	}

	updateFolderFilter(parsed, type.folderPath);
	updatePropertiesMap(parsed, properties, mutation);
	updateGeneratedView(parsed, type, properties, mutation);

	const dumped = dumpYaml(parsed);
	return (banner ? banner : "") + dumped;
}

function updateFolderFilter(doc: BaseDoc, folderPath: string): void {
	const wanted = `file.inFolder("${escapeForFilterArg(folderPath)}")`;
	const filters = doc.filters ?? {};
	const list = (filters.and as Array<string | BaseFilter> | undefined) ?? [];
	const idx = list.findIndex(
		(entry) =>
			typeof entry === "string" && /^file\.inFolder\(/.test(entry)
	);
	if (idx >= 0) {
		list[idx] = wanted;
	} else {
		list.unshift(wanted);
	}
	filters.and = list;
	doc.filters = filters;
}

function updatePropertiesMap(
	doc: BaseDoc,
	properties: ObjectProperty[],
	mutation: PropertyMutation | undefined
): void {
	const map: Record<string, BasePropertyEntry> = doc.properties ?? {};
	if (mutation) {
		for (const r of mutation.removed) {
			delete map[r.name];
		}
		for (const r of mutation.renamed) {
			if (map[r.from] !== undefined) {
				map[r.to] = map[r.from];
				delete map[r.from];
			}
		}
		for (const a of mutation.added) {
			if (map[a.name] === undefined) {
				map[a.name] = { displayName: a.name };
			}
		}
	} else {
		// No mutation context: ensure every effective property has an entry,
		// remove entries we previously owned that no longer apply. We avoid
		// stomping on unrelated keys (formulas, file.X, etc.) by only touching
		// names that match property names.
		const wanted = new Set(properties.map((p) => p.name));
		for (const key of Object.keys(map)) {
			if (key.startsWith("file.") || key.startsWith("formula.")) {
				continue;
			}
			if (!wanted.has(key)) delete map[key];
		}
		for (const p of properties) {
			if (map[p.name] === undefined) {
				map[p.name] = { displayName: p.name };
			}
		}
	}
	doc.properties = map;
}

/**
 * Update the auto-generated default view's `order` list. Other views (and
 * their order lists) are left untouched so user customisations survive.
 */
function updateGeneratedView(
	doc: BaseDoc,
	type: ObjectTypeDefinition,
	properties: ObjectProperty[],
	mutation: PropertyMutation | undefined
): void {
	const views = (doc.views ?? []) as BaseView[];
	const generatedName = `${GENERATED_VIEW_NAME_PREFIX}${type.pluralName}`;
	// We identify the generated view purely by name. If the user renames it
	// they "adopt" it and we leave it alone — except for the order list,
	// which we still try to keep aligned with the property set if there's
	// only one view in the file (the most common case).
	let view = views.find((v) => v.name === generatedName);
	if (!view && views.length === 1 && views[0].type === "table") {
		view = views[0];
	}

	if (!view) {
		view = {
			type: "table",
			name: generatedName,
			order: ["file.name", ...properties.map((p) => p.name)],
		};
		views.push(view);
		doc.views = views;
		return;
	}

	view.type = view.type ?? "table";
	view.name = view.name ?? generatedName;

	const order = view.order ?? ["file.name"];

	if (mutation) {
		for (const r of mutation.removed) {
			const idx = order.indexOf(r.name);
			if (idx >= 0) order.splice(idx, 1);
		}
		for (const r of mutation.renamed) {
			const idx = order.indexOf(r.from);
			if (idx >= 0) order[idx] = r.to;
		}
		for (const a of mutation.added) {
			if (!order.includes(a.name)) order.push(a.name);
		}
	} else {
		const wanted = new Set([
			"file.name",
			...properties.map((p) => p.name),
		]);
		// Drop properties no longer defined; keep file.* and formula.* refs.
		const filtered = order.filter(
			(item) =>
				wanted.has(item) ||
				item.startsWith("file.") ||
				item.startsWith("formula.")
		);
		for (const p of properties) {
			if (!filtered.includes(p.name)) filtered.push(p.name);
		}
		view.order = filtered;
		return;
	}

	view.order = order;
}

// ---------- helpers ----------

function dumpYaml(doc: BaseDoc): string {
	return yaml.dump(doc, {
		lineWidth: 120,
		noRefs: true,
		quotingType: '"',
	});
}

function escapeForFilterArg(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function splitBanner(content: string): { banner: string; body: string } {
	const lines = content.split("\n");
	const bannerLines: string[] = [];
	let i = 0;
	while (i < lines.length && /^\s*#/.test(lines[i])) {
		bannerLines.push(lines[i]);
		i += 1;
	}
	const banner = bannerLines.length > 0 ? bannerLines.join("\n") + "\n" : "";
	const body = lines.slice(i).join("\n");
	return { banner, body };
}
