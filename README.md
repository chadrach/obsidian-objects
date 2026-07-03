# Obsidian Objects

Capacities-style object-oriented note management for Obsidian. Define typed categories of notes, attach structured properties, and link between them with a fast `@` mention menu — all backed by Obsidian's native Bases views.

## What it does

Obsidian Objects lets you turn folders into **object types** — named categories like *Person*, *Project*, or *Book* — and treat every note inside as a typed object. Once a type is defined, the plugin:

- Stamps new notes with the type's properties as frontmatter
- Shows the type's icon next to every wikilink pointing at that note
- Maintains a `.base` file (Obsidian Bases overview) for each type automatically
- Opens the `.base` overview when you click the type's folder in the file explorer

## Features

### Object types

Each type has a singular name (*Person*), a plural name used for the folder (*People*), a [Lucide](https://lucide.dev) icon, and a list of typed properties. Types can be **nested**: a sub-type lives in a subfolder of its parent and inherits the parent's properties in addition to its own.

Types are managed through the **Object Type Settings** modal (ribbon icon or command palette). From there you can:

- Create a type from a new or existing folder
- Add, rename, reorder, and delete properties — changes cascade into every note in the folder
- Set a parent type to create a hierarchy
- Move the folder backing a type (all notes move with it)
- Repair a broken reference when a folder is deleted or renamed outside the plugin

### Properties

Properties are written as YAML frontmatter on every new note. Supported types:

| Type | Frontmatter value |
|------|-------------------|
| Text | string |
| List | string array |
| Number | number |
| Checkbox | boolean |
| Date | `YYYY-MM-DD` |
| Datetime | `YYYY-MM-DDTHH:mm` |

Each property can have a default value. Date and Datetime properties support `@now` as a special default that resolves to the current date/time at note creation. Text and List properties can be linked to another object type, which scopes the `@` menu when editing that frontmatter field.

The reserved `tags` and `aliases` frontmatter keys are available as per-type toggles (not as regular properties) since Obsidian treats them specially.

An optional **type identifier property** (default key: `Object-Type`) can be written to every note so external tools like Dataview can identify a note's type without relying on its folder path alone. The value is the qualified type name, slash-separated for sub-types (e.g. `Person/Employee`).

### `@` mention menu

Type the trigger character (default `@`) anywhere in the editor to open a fuzzy-search popup over all your typed objects.

- **Browse by type** — type rows appear alongside note rows; selecting a type row narrows the popup to that type only (the query becomes `@People/…`).
- **Filter within a type** — start typing after the type prefix to filter by note name.
- **Create inline** — if no note matches your query a *Create "…"* row appears; selecting it creates the note immediately and inserts the wikilink.
- **Daily notes** — natural-language queries like *"tomorrow"* or *"next Tuesday"* resolve to the correct daily note and create it if it doesn't exist yet.
- **Property context** — when the cursor is on a frontmatter line whose property is linked to a type, the menu scopes automatically to that type without any extra typing.

**Selection-to-link**: select text in the editor and press `@`. A floating popup opens while the selection stays highlighted; picking a note inserts a wikilink using the selected text as the display name.

An *Insert object mention* command is available in the command palette. A separate *Open object mention popup (mobile)* command with an `@` icon is provided for pinning to the mobile toolbar.

### Link icons

Every wikilink pointing at a typed note gets the type's icon prepended to it — in live-preview, reading mode, and the file explorer navigation pane. Toggle this off in Settings if you prefer plain links.

### Bases overview

Each type owns a `.base` file (e.g. `People/People.base`) that filters to that type's folder. The plugin creates the file when the type is first defined and surgically updates it as properties change — adding/removing columns from the default view and keeping the properties map in sync — while leaving any custom views, formulas, group-by settings, or column widths you've added inside the Bases UI untouched.

Daily Notes types get a cards view with `file.tags`, `file.links`, and `file.backlinks` columns by default instead of the standard table layout.

### Auto-apply prompt

When a Markdown file is created or moved into a typed folder (by any means — drag-and-drop, another plugin, a file manager), the plugin detects it and offers to stamp the type's frontmatter template onto the note. Existing frontmatter keys are left untouched; only missing defaults are filled in.

### Change object type

Right-click any Markdown note in the file explorer or editor tab to access **Change object type**. A modal lets you remap the note's existing properties to the new type's properties, delete ones you don't need, and move the note into the target type's folder. Obsidian's link-rewriting rewires any existing wikilinks pointing at the file.

### Daily Notes integration

When the core Daily Notes plugin is enabled, Obsidian Objects automatically registers it as a managed type with a calendar icon and generates a Bases overview. This means daily notes get icons next to their links just like any other type. The integration can be disabled in Settings; toggling it off removes the auto-generated type and its `.base` file.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Trigger character | `@` | Character that opens the mention menu |
| Type property name | `Object-Type` | Frontmatter key written on notes that have the type identifier enabled |
| Show icons on typed links | on | Prepend the type's icon to wikilinks and navigation rows |
| Clicking a typed folder opens its base | on | Click the folder in the file explorer to open the `.base` overview instead of expanding the tree |
| Parse natural-language dates | on | Offer daily note suggestions for queries like "tomorrow" or "next Tuesday" |
| Register Daily Notes as an object type | on | Mirror the core Daily Notes plugin as a managed type |

## Installation

> Obsidian Objects is a community plugin. Requires **Obsidian 1.7.0** or later and the **Bases** core plugin (for overview files).

1. Open **Settings → Community Plugins** and disable Safe Mode if prompted.
2. Click **Browse** and search for *Obsidian Objects*.
3. Install and enable the plugin.

Alternatively, download `main.js`, `styles.css`, and `manifest.json` from the latest release and copy them to `.obsidian/plugins/obsidian-objects/` in your vault.

## Getting started

1. Click the **layers** ribbon icon (or run *Open Object Type Settings* from the command palette).
2. Click **New type** and give it a name — *Person*, for example.
3. Add properties (*Name*, *Company*, *Email*) and save.
4. Open any note and type `@` to find or create a Person.

## Contributing

Issues and pull requests are welcome. The plugin is written in TypeScript and bundled with esbuild.

```bash
npm install
npm run dev   # watch mode
npm run build # production build
```
