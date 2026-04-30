import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import {
	DEFAULT_DATA,
	ObjectProperty,
	ObjectTypeDefinition,
	ObjectsPluginData,
	PluginSettings,
	newId,
} from "./types";
import {
	ensureFolder,
	filesInFolder,
	isUnder,
	joinPath,
	stringifyFrontmatter,
	uniquePath,
} from "./utils";
import { writeBaseFile } from "./baseFileManager";

/**
 * Owns the list of object types and mediates every mutation. Callers never
 * touch the raw data array — all changes go through one of the methods here
 * so that side effects (folder moves, .base writes, frontmatter cascades) are
 * applied consistently and the data is persisted exactly once per change.
 */
export class ObjectTypeManager {
	private data: ObjectsPluginData;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly app: App,
		data: ObjectsPluginData | null,
		private readonly persist: (d: ObjectsPluginData) => Promise<void>
	) {
		this.data = normalizeData(data);
	}

	// ----- data access -----

	getData(): ObjectsPluginData {
		return this.data;
	}

	getSettings(): PluginSettings {
		return this.data.settings;
	}

	getTypes(): ObjectTypeDefinition[] {
		return this.data.types;
	}

	getTypeById(id: string): ObjectTypeDefinition | undefined {
		return this.data.types.find((t) => t.id === id);
	}

	getTypeByFolder(folderPath: string): ObjectTypeDefinition | undefined {
		const p = normalizePath(folderPath);
		return this.data.types.find((t) => t.folderPath === p);
	}

	/** Most-specific type owning `path` (walks up the folder tree). */
	getTypeForPath(filePath: string): ObjectTypeDefinition | undefined {
		let best: ObjectTypeDefinition | undefined;
		for (const t of this.data.types) {
			if (isUnder(filePath, t.folderPath)) {
				if (!best || t.folderPath.length > best.folderPath.length) {
					best = t;
				}
			}
		}
		return best;
	}

	/** Properties for a type, flattened with inherited parents. */
	getEffectiveProperties(type: ObjectTypeDefinition): ObjectProperty[] {
		const seen = new Map<string, ObjectProperty>();
		const chain = this.getTypeChain(type);
		for (const t of chain) {
			for (const p of t.properties) {
				if (!seen.has(p.name.toLowerCase())) {
					seen.set(p.name.toLowerCase(), p);
				}
			}
		}
		return Array.from(seen.values());
	}

	/** From root parent to the type itself. */
	getTypeChain(type: ObjectTypeDefinition): ObjectTypeDefinition[] {
		const chain: ObjectTypeDefinition[] = [];
		let current: ObjectTypeDefinition | undefined = type;
		const guard = new Set<string>();
		while (current && !guard.has(current.id)) {
			guard.add(current.id);
			chain.unshift(current);
			current = current.parentId
				? this.getTypeById(current.parentId)
				: undefined;
		}
		return chain;
	}

	/** Dotted name showing parent/child, e.g. "Person/Family". */
	getQualifiedName(type: ObjectTypeDefinition): string {
		return this.getTypeChain(type)
			.map((t) => t.name)
			.join("/");
	}

	// ----- mutations -----

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
		this.data.settings = { ...this.data.settings, ...patch };
		await this.save();
	}

	/**
	 * Create a new object type. Creates the folder and the .base file and
	 * persists the definition. If `folderPath` already exists the caller is
	 * re-adopting an existing folder as a type, which is fine.
	 */
	async createType(input: {
		name: string;
		pluralName: string;
		icon: string;
		folderPath: string;
		parentId?: string | null;
		properties?: ObjectProperty[];
		managed?: "daily-notes" | null;
	}): Promise<ObjectTypeDefinition> {
		const folderPath = normalizePath(input.folderPath);
		if (this.getTypeByFolder(folderPath)) {
			throw new Error(
				`Folder ${folderPath} is already an object type.`
			);
		}
		await ensureFolder(this.app.vault, folderPath);
		const type: ObjectTypeDefinition = {
			id: newId(),
			name: input.name,
			pluralName: input.pluralName,
			icon: input.icon || "box",
			folderPath,
			basePath: basePathFor(folderPath, input.pluralName),
			parentId: input.parentId ?? null,
			properties: input.properties ?? [],
			managed: input.managed ?? null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.data.types.push(type);
		await this.rewriteBase(type);
		await this.save();
		return type;
	}

	/**
	 * Apply a patch to a type. Adding/removing/renaming properties cascades
	 * into every note in the folder. The caller is expected to have confirmed
	 * any destructive side effects with the user first (see
	 * `previewPropertyChange`).
	 */
	async updateType(
		id: string,
		patch: Partial<
			Pick<
				ObjectTypeDefinition,
				"name" | "pluralName" | "icon" | "parentId" | "properties"
			>
		>,
		options: { removeDeletedFromNotes?: boolean } = {}
	): Promise<ObjectTypeDefinition> {
		const type = this.getTypeById(id);
		if (!type) throw new Error(`Unknown type id ${id}`);

		const prevProperties = [...type.properties];

		if (patch.name !== undefined) type.name = patch.name;
		if (patch.pluralName !== undefined) type.pluralName = patch.pluralName;
		if (patch.icon !== undefined) type.icon = patch.icon;
		if (patch.parentId !== undefined) type.parentId = patch.parentId;
		if (patch.properties !== undefined) type.properties = patch.properties;
		type.updatedAt = Date.now();

		let mutation: PropertyMutation | undefined;
		if (patch.properties !== undefined) {
			mutation = computeMutation(prevProperties, type.properties);
			await this.cascadePropertyChanges(
				type,
				mutation,
				options.removeDeletedFromNotes ?? false
			);
		}

		await this.rewriteBase(type, mutation);
		await this.save();
		return type;
	}

	/**
	 * Relocate the folder backing a type. The folder and every nested file
	 * (including the .base file) are moved on disk; the type's `folderPath`
	 * and `basePath` are rewritten accordingly.
	 *
	 * Use case: the user picked a different "Object Location" in the modal,
	 * either pointing the type at a new folder name or moving it under a
	 * different parent. The caller is expected to have shown a confirmation
	 * dialog with the affected file count first (see `getMoveImpact`).
	 */
	async moveType(
		id: string,
		newFolderPath: string
	): Promise<ObjectTypeDefinition> {
		const type = this.getTypeById(id);
		if (!type) throw new Error(`Unknown type id ${id}`);
		const target = normalizePath(newFolderPath);
		if (target === type.folderPath) return type;

		const folder = this.app.vault.getAbstractFileByPath(type.folderPath);
		const targetExisting = this.app.vault.getAbstractFileByPath(target);

		if (folder instanceof TFolder) {
			if (targetExisting && !(targetExisting instanceof TFolder)) {
				throw new Error(
					`Cannot move ${type.folderPath} to ${target}: a file with that name already exists.`
				);
			}
			if (!targetExisting) {
				// Ensure parent exists (vault.rename will create the leaf).
				const parent = target.includes("/")
					? target.slice(0, target.lastIndexOf("/"))
					: "";
				if (parent) await ensureFolder(this.app.vault, parent);
				await this.app.fileManager.renameFile(folder, target);
			} else {
				// Target folder already exists — merge: move each child in.
				await mergeFolderInto(this.app, folder, targetExisting as TFolder);
			}
		} else {
			// Source folder doesn't exist (broken reference). Just create the
			// target so subsequent .base writes succeed.
			await ensureFolder(this.app.vault, target);
		}

		const oldBasePath = type.basePath;
		type.folderPath = target;
		type.basePath = basePathFor(target, type.pluralName);
		type.updatedAt = Date.now();

		// If the .base file moved with the folder rename it'll have followed
		// to <target>/<old-name>.base. Find it and rename to the canonical
		// `<plural>.base` if it doesn't already match.
		await reconcileBaseFilePath(this.app, type, oldBasePath);

		await this.rewriteBase(type);
		await this.save();
		return type;
	}

	/** Files affected by a hypothetical folder move. */
	getMoveImpact(typeId: string): {
		fileCount: number;
		subfolderCount: number;
	} {
		const type = this.getTypeById(typeId);
		if (!type) return { fileCount: 0, subfolderCount: 0 };
		const folder = this.app.vault.getAbstractFileByPath(type.folderPath);
		if (!(folder instanceof TFolder)) {
			return { fileCount: 0, subfolderCount: 0 };
		}
		let fileCount = 0;
		let subfolderCount = 0;
		const walk = (f: TFolder): void => {
			for (const child of f.children) {
				if (child instanceof TFile) fileCount += 1;
				else if (child instanceof TFolder) {
					subfolderCount += 1;
					walk(child);
				}
			}
		};
		walk(folder);
		return { fileCount, subfolderCount };
	}

	/**
	 * Delete a type. Does not delete the folder or any notes — only the
	 * definition and (optionally) the .base file.
	 */
	async deleteType(
		id: string,
		options: { deleteBaseFile?: boolean } = {}
	): Promise<void> {
		const type = this.getTypeById(id);
		if (!type) return;
		this.data.types = this.data.types.filter((t) => t.id !== id);
		// Orphan any sub-types — they stay in the list but lose their parent.
		for (const child of this.data.types) {
			if (child.parentId === id) child.parentId = null;
		}
		if (options.deleteBaseFile) {
			const base = this.app.vault.getAbstractFileByPath(type.basePath);
			if (base instanceof TFile) {
				await this.app.fileManager.trashFile(base);
			}
		}
		await this.save();
	}

	// ----- cascade helpers -----

	/**
	 * Describe the effects of a proposed property list change so the caller
	 * can present a confirmation UI before committing.
	 */
	previewPropertyChange(
		typeId: string,
		proposed: ObjectProperty[]
	): {
		added: ObjectProperty[];
		removed: ObjectProperty[];
		renamed: Array<{ from: string; to: string; id: string }>;
		affectedFileCount: number;
	} {
		const type = this.getTypeById(typeId);
		if (!type) {
			return {
				added: [],
				removed: [],
				renamed: [],
				affectedFileCount: 0,
			};
		}
		const prev = type.properties;
		const prevById = new Map(prev.map((p) => [p.id, p]));
		const proposedById = new Map(proposed.map((p) => [p.id, p]));

		const added = proposed.filter((p) => !prevById.has(p.id));
		const removed = prev.filter((p) => !proposedById.has(p.id));
		const renamed = proposed
			.filter((p) => {
				const old = prevById.get(p.id);
				return old && old.name !== p.name;
			})
			.map((p) => ({
				id: p.id,
				from: prevById.get(p.id)!.name,
				to: p.name,
			}));
		return {
			added,
			removed,
			renamed,
			affectedFileCount: filesInFolder(
				this.app.vault,
				type.folderPath
			).length,
		};
	}

	private async cascadePropertyChanges(
		type: ObjectTypeDefinition,
		mutation: PropertyMutation,
		removeDeletedFromNotes: boolean
	): Promise<void> {
		const { added, removed, renamed } = mutation;
		if (
			added.length === 0 &&
			removed.length === 0 &&
			renamed.length === 0
		) {
			return;
		}

		const files = filesInFolder(this.app.vault, type.folderPath);
		let updated = 0;
		for (const file of files) {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				for (const r of renamed) {
					if (r.from in fm && !(r.to in fm)) {
						fm[r.to] = fm[r.from];
						delete fm[r.from];
					}
				}
				for (const prop of added) {
					if (!(prop.name in fm)) {
						fm[prop.name] = propertyInitialValue(prop);
					}
				}
				if (removeDeletedFromNotes) {
					for (const prop of removed) {
						delete fm[prop.name];
					}
				}
			});
			updated += 1;
		}
		if (updated > 0) {
			new Notice(`Updated ${updated} ${type.pluralName} note(s).`);
		}
	}

	// ----- note creation -----

	/**
	 * Create a new note of this object type, applying the effective property
	 * list as frontmatter. Returns the created TFile.
	 */
	async createObjectNote(
		type: ObjectTypeDefinition,
		title: string
	): Promise<TFile> {
		await ensureFolder(this.app.vault, type.folderPath);
		const properties = this.getEffectiveProperties(type);
		const fm: Record<string, unknown> = {};
		fm[this.data.settings.typePropertyName] =
			this.getQualifiedName(type);
		for (const p of properties) {
			fm[p.name] = propertyInitialValue(p);
		}
		const path = uniquePath(
			this.app.vault,
			type.folderPath,
			title || "Untitled"
		);
		const content = stringifyFrontmatter(fm);
		const file = await this.app.vault.create(path, content);
		return file;
	}

	async rewriteBase(
		type: ObjectTypeDefinition,
		mutation?: PropertyMutation
	): Promise<void> {
		try {
			await writeBaseFile(this.app, type, this, mutation);
		} catch (err) {
			console.warn("Failed to write base file", err);
		}
	}

	// ----- diagnostics / broken references -----

	getBrokenReferences(): Array<BrokenReference> {
		const out: BrokenReference[] = [];
		for (const t of this.data.types) {
			const folder = this.app.vault.getAbstractFileByPath(
				t.folderPath
			);
			if (!(folder instanceof TFolder)) {
				out.push({
					type: t,
					missing: "folder",
					expectedPath: t.folderPath,
					detail: `Folder "${t.folderPath}" no longer exists. The type's notes can't be located until you point it at a new folder or recreate the original.`,
				});
			}
			const base = this.app.vault.getAbstractFileByPath(t.basePath);
			if (!(base instanceof TFile)) {
				out.push({
					type: t,
					missing: "base",
					expectedPath: t.basePath,
					detail: `Overview base file "${t.basePath}" is missing. It will be re-generated automatically the next time you save changes to this type.`,
				});
			}
		}
		return out;
	}

	getBrokenReferencesForType(typeId: string): BrokenReference[] {
		return this.getBrokenReferences().filter(
			(b) => b.type.id === typeId
		);
	}

	/** Repair a broken reference by pointing the type at a new folder/base. */
	async repairType(
		id: string,
		patch: Partial<Pick<ObjectTypeDefinition, "folderPath" | "basePath">>
	): Promise<void> {
		const type = this.getTypeById(id);
		if (!type) return;
		if (patch.folderPath) {
			type.folderPath = normalizePath(patch.folderPath);
		}
		if (patch.basePath) {
			type.basePath = normalizePath(patch.basePath);
		} else if (patch.folderPath) {
			type.basePath = basePathFor(type.folderPath, type.pluralName);
		}
		type.updatedAt = Date.now();
		await this.rewriteBase(type);
		await this.save();
	}

	// ----- persistence -----

	private async save(): Promise<void> {
		await this.persist(this.data);
		for (const l of this.listeners) l();
	}
}

export interface PropertyMutation {
	added: ObjectProperty[];
	removed: { id: string; name: string }[];
	renamed: { id: string; from: string; to: string }[];
}

export interface BrokenReference {
	type: ObjectTypeDefinition;
	missing: "folder" | "base";
	expectedPath: string;
	detail: string;
}

function computeMutation(
	prev: ObjectProperty[],
	next: ObjectProperty[]
): PropertyMutation {
	const prevById = new Map(prev.map((p) => [p.id, p]));
	const nextById = new Map(next.map((p) => [p.id, p]));
	return {
		added: next.filter((p) => !prevById.has(p.id)),
		removed: prev
			.filter((p) => !nextById.has(p.id))
			.map((p) => ({ id: p.id, name: p.name })),
		renamed: next
			.filter((p) => {
				const old = prevById.get(p.id);
				return old && old.name !== p.name;
			})
			.map((p) => ({
				id: p.id,
				from: prevById.get(p.id)!.name,
				to: p.name,
			})),
	};
}

async function mergeFolderInto(
	app: App,
	source: TFolder,
	target: TFolder
): Promise<void> {
	for (const child of [...source.children]) {
		const dest = `${target.path}/${child.name}`;
		await app.fileManager.renameFile(child, dest);
	}
	const remaining = source.children.length;
	if (remaining === 0) {
		await app.fileManager.trashFile(source);
	}
}

async function reconcileBaseFilePath(
	app: App,
	type: ObjectTypeDefinition,
	previousBasePath: string
): Promise<void> {
	const wantedPath = type.basePath;
	if (previousBasePath === wantedPath) return;
	// `<previous folder>/<filename>` will have been moved with the folder
	// rename, so look for the original filename inside the new folder.
	const oldName = previousBasePath.split("/").pop();
	if (!oldName) return;
	const movedPath = `${type.folderPath}/${oldName}`;
	const candidate = app.vault.getAbstractFileByPath(movedPath);
	if (candidate instanceof TFile && movedPath !== wantedPath) {
		try {
			await app.fileManager.renameFile(candidate, wantedPath);
		} catch (err) {
			console.warn("Could not rename .base file after folder move", err);
		}
	}
}

function normalizeData(data: ObjectsPluginData | null): ObjectsPluginData {
	if (!data) return structuredClone(DEFAULT_DATA);
	return {
		...structuredClone(DEFAULT_DATA),
		...data,
		settings: { ...DEFAULT_DATA.settings, ...data.settings },
		types: data.types ?? [],
	};
}

export function basePathFor(folderPath: string, pluralName: string): string {
	const name = (pluralName || "Overview").replace(/[\\/:*?"<>|]/g, "");
	return joinPath(folderPath, `${name}.base`);
}

export function propertyInitialValue(prop: ObjectProperty): unknown {
	if (prop.defaultValue !== undefined && prop.defaultValue !== null) {
		return prop.defaultValue;
	}
	switch (prop.type) {
		case "list":
		case "tags":
		case "aliases":
			return [];
		case "checkbox":
			return false;
		case "number":
			return null;
		case "date":
		case "datetime":
		case "text":
		default:
			return "";
	}
}
