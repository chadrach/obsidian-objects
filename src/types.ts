/**
 * Core data model for Obsidian Objects.
 *
 * An "object type" maps a folder to a class of notes that share a set of
 * predefined properties, an icon, and an overview (.base) file. Types can be
 * nested: a sub-type lives in a subfolder of its parent and inherits the
 * parent's properties in addition to any it defines locally.
 */

export type PropertyType =
	| "text"
	| "list"
	| "number"
	| "checkbox"
	| "date"
	| "datetime"
	| "tags"
	| "aliases";

export interface ObjectProperty {
	/** Stable id so renames don't lose track of the property. */
	id: string;
	name: string;
	type: PropertyType;
	/** Default value written to frontmatter when a new note is created. */
	defaultValue?: string | number | boolean | string[] | null;
	/**
	 * If the property should resolve to links of a particular object type,
	 * this is the id of the target type. Only meaningful for `text` and `list`.
	 */
	linkedTypeId?: string | null;
	/** Optional freeform description shown in the settings UI. */
	description?: string;
}

export interface ObjectTypeDefinition {
	/** Stable id used as the frontmatter value and internal reference. */
	id: string;
	/** Singular display name, e.g. "Person". */
	name: string;
	/**
	 * Plural name; also used as the folder name by default. The user can
	 * manually rename the folder, in which case `folderPath` becomes the
	 * source of truth and `pluralName` is purely display.
	 */
	pluralName: string;
	/** Lucide icon name shown next to links and folders. */
	icon: string;
	/** Absolute vault path to the folder backing this type. */
	folderPath: string;
	/** Absolute vault path to the .base file backing this type. */
	basePath: string;
	/** Id of the parent type when this is a sub-type. */
	parentId?: string | null;
	/** Locally-defined properties (does not include inherited ones). */
	properties: ObjectProperty[];
	/**
	 * When true, new notes of this type get an empty `tags` frontmatter
	 * entry. Obsidian reserves the `tags` property name for the Tags
	 * property type, so it can't be expressed in the `properties` array.
	 * Toggling this off does not strip tags from existing notes.
	 */
	showTags?: boolean;
	/** As `showTags`, but for the reserved `aliases` property. */
	showAliases?: boolean;
	/** Creation + modification timestamps for bookkeeping. */
	createdAt: number;
	updatedAt: number;
	/** Whether this type was auto-generated (e.g. Daily Notes). */
	managed?: "daily-notes" | null;
}

export interface ObjectsPluginData {
	version: 1;
	types: ObjectTypeDefinition[];
	settings: PluginSettings;
}

export interface PluginSettings {
	/** Trigger character for the inline object menu. */
	triggerChar: string;
	/** Property written into every object note identifying its type/sub-type. */
	typePropertyName: string;
	/** If true, render lucide icons next to object wikilinks. */
	showLinkIcons: boolean;
	/** If true, clicking a typed folder opens its .base file. */
	folderClickOpensBase: boolean;
	/** If true, parse natural-language dates in the @ menu. */
	parseNaturalLanguageDates: boolean;
	/** If true, register Daily Notes as a managed object type. */
	registerDailyNotes: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	triggerChar: "@",
	typePropertyName: "Object-Type",
	showLinkIcons: true,
	folderClickOpensBase: true,
	parseNaturalLanguageDates: true,
	registerDailyNotes: true,
};

export const DEFAULT_DATA: ObjectsPluginData = {
	version: 1,
	types: [],
	settings: DEFAULT_SETTINGS,
};

export function newId(): string {
	return (
		Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
	);
}
