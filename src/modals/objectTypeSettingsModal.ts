import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	Setting,
	TFile,
	TFolder,
	setIcon,
} from "obsidian";
import {
	ObjectProperty,
	ObjectTypeDefinition,
	PropertyType,
	newId,
} from "../types";
import { ObjectTypeManager } from "../objectTypeManager";
import { confirmAction } from "./confirmModal";
import { FolderPickerModal } from "../folderPicker";
import { joinPath, safeFolderName } from "../utils";

// Tags and Aliases are intentionally excluded — Obsidian reserves the
// "tags" and "aliases" frontmatter keys for the Tags / Aliases property
// types respectively, so they're modelled as per-type checkboxes elsewhere
// in the UI rather than as user-defined properties.
const PROPERTY_TYPES: Array<{ value: PropertyType; label: string }> = [
	{ value: "text", label: "Text" },
	{ value: "list", label: "List" },
	{ value: "number", label: "Number" },
	{ value: "checkbox", label: "Checkbox" },
	{ value: "date", label: "Date" },
	{ value: "datetime", label: "Datetime" },
];

/**
 * The "Object Type Settings" modal — the main configuration surface.
 *
 * Two screens, switched via `screen`:
 *   - "list": an overview of every defined type, with broken-reference
 *     warnings calling out exactly what's wrong and per-type buttons.
 *   - "edit": the editor for a single type. The caller can jump straight
 *     into this screen by passing an initial type or a folder path.
 *
 * "Object Location" semantics:
 *   - When *creating* a new type, the user can pick an existing folder to
 *     adopt or type a new folder name to create. We confirm folder creation.
 *   - When *editing* an existing type, the picker triggers a vault move:
 *     the folder, every nested file and the .base file are renamed in
 *     place. The user is shown the impact (file/subfolder counts) before
 *     committing.
 */
export class ObjectTypeSettingsModal extends Modal {
	private screen: "list" | "edit" = "list";
	private draft: TypeDraft | null = null;

	constructor(
		app: App,
		private readonly manager: ObjectTypeManager,
		private readonly opts: {
			initialTypeId?: string;
			initialFolderPath?: string;
		} = {}
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("obsidian-objects-modal");
		if (this.opts.initialTypeId) {
			const type = this.manager.getTypeById(this.opts.initialTypeId);
			if (type) {
				this.draft = draftFromType(type);
				this.screen = "edit";
			}
		} else if (this.opts.initialFolderPath) {
			const existing = this.manager.getTypeByFolder(
				this.opts.initialFolderPath
			);
			this.draft = existing
				? draftFromType(existing)
				: blankDraft(this.opts.initialFolderPath);
			this.screen = "edit";
		}
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		if (this.screen === "list") {
			this.renderList();
		} else {
			this.renderEdit();
		}
	}

	// ---------- list screen ----------

	private renderList(): void {
		this.titleEl.setText("Object Types");

		// Daily Notes is auto-managed via the plugin settings toggle; we
		// deliberately keep it out of this UI so the user can't accidentally
		// override their core Daily Notes plugin configuration here.
		const broken = this.manager
			.getBrokenReferences()
			.filter((b) => b.type.managed !== "daily-notes");
		if (broken.length > 0) {
			const banner = this.contentEl.createDiv({
				cls: "obsidian-objects-banner",
			});
			banner.createDiv({
				cls: "obsidian-objects-banner__title",
				text: `${broken.length} broken reference${
					broken.length === 1 ? "" : "s"
				}`,
			});
			const list = banner.createEl("ul", {
				cls: "obsidian-objects-banner__list",
			});
			for (const issue of broken) {
				const li = list.createEl("li");
				const name = this.manager.getQualifiedName(issue.type);
				li.createEl("strong", { text: `${name}: ` });
				li.appendText(
					issue.missing === "folder"
						? `folder "${issue.expectedPath}" is missing.`
						: `overview file "${issue.expectedPath}" is missing.`
				);
				const fix = li.createSpan();
				fix.appendText(" ");
				fix.createEl("a", {
					text: "Open settings",
					href: "#",
				}).addEventListener("click", (evt) => {
					evt.preventDefault();
					this.draft = draftFromType(issue.type);
					this.screen = "edit";
					this.render();
				});
			}
		}

		const list = this.contentEl.createDiv({
			cls: "obsidian-objects-type-list",
		});
		const types = this.manager
			.getTypes()
			.filter((t) => t.managed !== "daily-notes");
		if (types.length === 0) {
			list.createDiv({
				cls: "obsidian-objects-empty",
				text: "No object types yet. Click \"New type\" to create your first one.",
			});
		}
		for (const type of types) {
			const issues =
				this.manager.getBrokenReferencesForType(type.id);
			const row = list.createDiv({ cls: "obsidian-objects-type-row" });
			if (issues.length > 0) row.addClass("has-issue");
			const icon = row.createSpan({
				cls: "obsidian-objects-type-row__icon",
			});
			setIcon(icon, type.icon || "box");
			const text = row.createDiv({
				cls: "obsidian-objects-type-row__text",
			});
			text.createDiv({
				cls: "obsidian-objects-type-row__title",
				text: this.manager.getQualifiedName(type),
			});
			text.createDiv({
				cls: "obsidian-objects-type-row__sub",
				text: `${type.folderPath} · ${type.properties.length} propert${
					type.properties.length === 1 ? "y" : "ies"
				}`,
			});
			if (issues.length > 0) {
				const issueEl = text.createDiv({
					cls: "obsidian-objects-type-row__issue",
				});
				issueEl.setText(
					issues
						.map((i) =>
							i.missing === "folder"
								? `Folder missing: ${i.expectedPath}`
								: `Base file missing: ${i.expectedPath}`
						)
						.join(" · ")
				);
			}
			const actions = row.createDiv({
				cls: "obsidian-objects-type-row__actions",
			});
			new ButtonComponent(actions)
				.setButtonText("Edit")
				.onClick(() => {
					this.draft = draftFromType(type);
					this.screen = "edit";
					this.render();
				});
			new ButtonComponent(actions)
				.setButtonText("Delete")
				.setWarning()
				.onClick(() => void this.handleDelete(type));
		}

		const footer = this.contentEl.createDiv({
			cls: "obsidian-objects-modal__footer",
		});
		new ButtonComponent(footer)
			.setButtonText("New type")
			.setCta()
			.onClick(() => {
				this.draft = blankDraft();
				this.screen = "edit";
				this.render();
			});
	}

	private async handleDelete(type: ObjectTypeDefinition): Promise<void> {
		const choice = await confirmAction(this.app, {
			title: `Delete object type "${type.name}"?`,
			body: `Notes in ${type.folderPath} will not be deleted. You can also remove the overview base file.`,
			extraButtons: [
				{
					text: "Delete type + base file",
					value: "delete-with-base",
				},
			],
			confirmText: "Delete type only",
		});
		if (choice === null || choice === "cancel") return;
		await this.manager.deleteType(type.id, {
			deleteBaseFile: choice === "delete-with-base",
		});
		this.render();
	}

	// ---------- edit screen ----------

	private renderEdit(): void {
		const draft = this.draft;
		if (!draft) return;
		this.titleEl.setText(
			draft.existingId ? `Edit ${draft.name || "object type"}` : "New object type"
		);

		// Forward-declare so the parent dropdown handler can refresh the
		// inherited-properties block once it's been mounted below.
		let propsEl: HTMLElement | null = null;
		const refreshProps = () => {
			if (propsEl) this.renderProperties(draft, propsEl);
		};

		// Per-type broken-reference banner.
		if (draft.existingId) {
			const issues = this.manager.getBrokenReferencesForType(
				draft.existingId
			);
			if (issues.length > 0) {
				const banner = this.contentEl.createDiv({
					cls: "obsidian-objects-banner",
				});
				banner.createDiv({
					cls: "obsidian-objects-banner__title",
					text: "This type has broken references",
				});
				const list = banner.createEl("ul", {
					cls: "obsidian-objects-banner__list",
				});
				for (const issue of issues) {
					list.createEl("li", { text: issue.detail });
				}
				const fix = banner.createDiv();
				new ButtonComponent(fix)
					.setButtonText("Pick replacement location…")
					.onClick(() =>
						this.openLocationPicker(draft, () => this.render())
					);
			}
		}

		new Setting(this.contentEl)
			.setName("Type name")
			.setDesc("Singular, displayed in menus. e.g. \"Person\".")
			.addText((t) =>
				t
					.setPlaceholder("Person")
					.setValue(draft.name)
					.onChange((v) => {
						draft.name = v;
					})
			);

		new Setting(this.contentEl)
			.setName("Plural name")
			.setDesc(
				"Also the folder name. Renaming this renames the folder."
			)
			.addText((t) =>
				t
					.setPlaceholder("People")
					.setValue(draft.pluralName)
					.onChange((v) => {
						draft.pluralName = v;
					})
			);

		// Sub-type of comes BEFORE Location: picking a parent forces the
		// location to live inside that parent, so the location field reads
		// as a derived consequence rather than an independent choice.
		const parentSetting = new Setting(this.contentEl)
			.setName("Sub-type of")
			.setDesc(
				"Parent object type. Sub-type folders are nested inside the parent and inherit its properties."
			);
		let locationDisplay: HTMLElement;
		let locationPickerBtn: ButtonComponent;
		const updateLocationVisual = () => {
			if (!locationDisplay || !locationPickerBtn) return;
			if (draft.parentId) {
				const parent = this.manager.getTypeById(draft.parentId);
				const parentPath = parent?.folderPath ?? "";
				draft.locationPath = parentPath;
				const label = parentPath
					? `Inside ${parent?.name ?? "parent"} → ${parentPath}`
					: `Inside ${parent?.name ?? "parent"} (vault root)`;
				locationDisplay.setText(label);
				locationPickerBtn.setDisabled(true);
			} else {
				const path = draft.locationPath || "";
				locationDisplay.setText(
					path ? `Current: ${path}` : "Vault root"
				);
				locationPickerBtn.setDisabled(false);
			}
		};
		parentSetting.addDropdown((d) => {
			d.addOption("", "— None (top-level type) —");
			for (const t of this.manager.getTypes()) {
				if (t.id === draft.existingId) continue;
				d.addOption(t.id, this.manager.getQualifiedName(t));
			}
			d.setValue(draft.parentId ?? "");
			d.onChange((v) => {
				draft.parentId = v || null;
				updateLocationVisual();
				refreshProps();
			});
		});

		const locationSetting = new Setting(this.contentEl)
			.setName("Location")
			.setDesc(
				"Folder that contains the type's folder. Default is the vault root."
			);
		locationDisplay = locationSetting.descEl.createDiv({
			cls: "obsidian-objects-location-current",
		});
		locationSetting.addButton((b) => {
			locationPickerBtn = b
				.setButtonText("Pick location…")
				.onClick(() =>
					this.openLocationPicker(draft, updateLocationVisual)
				);
		});
		updateLocationVisual();

		new Setting(this.contentEl)
			.setName("Icon")
			.setDesc("Lucide icon name, e.g. \"user\", \"building\", \"calendar\".")
			.addText((t) =>
				t
					.setValue(draft.icon)
					.setPlaceholder("box")
					.onChange((v) => {
						draft.icon = v;
					})
			);

		this.contentEl.createEl("h3", { text: "Properties" });
		propsEl = this.contentEl.createDiv({
			cls: "obsidian-objects-props",
		});
		this.renderProperties(draft, propsEl);

		const footer = this.contentEl.createDiv({
			cls: "obsidian-objects-modal__footer",
		});
		new ButtonComponent(footer)
			.setButtonText("Back")
			.onClick(() => {
				this.screen = "list";
				this.draft = null;
				this.render();
			});
		new ButtonComponent(footer)
			.setButtonText("Save")
			.setCta()
			.onClick(() => void this.handleSave());
	}

	/**
	 * Pick the parent folder that will *contain* the type's folder. The
	 * picker offers every existing folder in the vault (including the
	 * root). The actual type folder is composed elsewhere as
	 * `locationPath + pluralName` so we never let the user type that path
	 * directly.
	 */
	private openLocationPicker(
		draft: TypeDraft,
		afterChange: () => void
	): void {
		new FolderPickerModal(
			this.app,
			(folder) => {
				draft.locationPath = folder.path;
				afterChange();
			},
			{ title: "Select location…" }
		).open();
	}

	private renderProperties(draft: TypeDraft, container: HTMLElement): void {
		container.empty();

		if (draft.parentId) {
			const parent = this.manager.getTypeById(draft.parentId);
			if (parent) {
				const inherited = this.manager
					.getEffectiveProperties(parent)
					.map((p) => p.name)
					.join(", ");
				container.createDiv({
					cls: "obsidian-objects-inherited",
					text: `Inherited from ${parent.name}: ${inherited || "— none —"}`,
				});
			}
		}

		// Tags / Aliases toggles. Obsidian reserves these property names so
		// they can't be expressed as regular Object Properties; we model
		// them as on/off switches that decide whether new notes of this
		// type get the corresponding empty frontmatter entry. Toggling off
		// does not strip values from existing notes.
		const reserved = container.createDiv({
			cls: "obsidian-objects-prop-toggles",
		});
		new Setting(reserved)
			.setName("Show Tags property by default")
			.setDesc(
				"When creating a new note of this type, include an empty `tags:` entry in its frontmatter. Existing notes are not modified."
			)
			.addToggle((t) =>
				t.setValue(draft.showTags ?? false).onChange((v) => {
					draft.showTags = v;
				})
			);
		new Setting(reserved)
			.setName("Show Aliases property by default")
			.setDesc(
				"When creating a new note of this type, include an empty `aliases:` entry in its frontmatter. Existing notes are not modified."
			)
			.addToggle((t) =>
				t.setValue(draft.showAliases ?? false).onChange((v) => {
					draft.showAliases = v;
				})
			);

		for (const prop of draft.properties) {
			const row = container.createDiv({
				cls: "obsidian-objects-prop-row",
			});
			// Wrap name input so we can overlay the collision warning icon.
			const nameWrap = row.createDiv({
				cls: "obsidian-objects-prop-row__name-wrap",
			});
			const nameInput = nameWrap.createEl("input", {
				type: "text",
				cls: "obsidian-objects-prop-row__name",
			});
			nameInput.value = prop.name;
			nameInput.placeholder = "Property name";
			const collisionIcon = nameWrap.createSpan({
				cls: "obsidian-objects-prop-collision",
			});
			setIcon(collisionIcon, "info");

			const updateCollision = () => {
				const name = nameInput.value.trim();
				if (!name) {
					collisionIcon.removeClass("is-visible");
					collisionIcon.removeAttribute("aria-label");
					return;
				}
				const conflicts = this.manager
					.getTypes()
					.filter((t) => t.id !== draft.existingId)
					.filter((t) =>
						this.manager
							.getEffectiveProperties(t)
							.some(
								(p) =>
									p.name.toLowerCase() ===
									name.toLowerCase()
							)
					);
				if (conflicts.length > 0) {
					const typeList = conflicts
						.map((t) => t.name)
						.join(", ");
					collisionIcon.setAttribute(
						"aria-label",
						`"${name}" is also defined on: ${typeList}. ` +
							`Sharing a name means Bases views can display both types' values in the same column.`
					);
					collisionIcon.addClass("is-visible");
				} else {
					collisionIcon.removeClass("is-visible");
					collisionIcon.removeAttribute("aria-label");
				}
			};

			nameInput.addEventListener("input", () => {
				prop.name = nameInput.value;
				updateCollision();
			});
			updateCollision();

			const typeSelect = row.createEl("select", {
				cls: "obsidian-objects-prop-row__type",
			});
			for (const t of PROPERTY_TYPES) {
				const opt = typeSelect.createEl("option", {
					text: t.label,
					value: t.value,
				});
				if (t.value === prop.type) opt.selected = true;
			}
			typeSelect.addEventListener("change", () => {
				prop.type = typeSelect.value as PropertyType;
				this.renderProperties(draft, container);
			});

			if (prop.type === "text" || prop.type === "list") {
				const linkSelect = row.createEl("select", {
					cls: "obsidian-objects-prop-row__link",
				});
				linkSelect.createEl("option", {
					text: "No link",
					value: "",
				});
				for (const t of this.manager.getTypes()) {
					if (t.id === draft.existingId) continue;
					const opt = linkSelect.createEl("option", {
						text: t.name,
						value: t.id,
					});
					if (prop.linkedTypeId === t.id) opt.selected = true;
				}
				linkSelect.addEventListener("change", () => {
					prop.linkedTypeId = linkSelect.value || null;
				});
			}

			const defaultInput = row.createEl("input", {
				type: "text",
				cls: "obsidian-objects-prop-row__default",
			});
			defaultInput.placeholder = "Default";
			if (
				prop.defaultValue !== undefined &&
				prop.defaultValue !== null
			) {
				defaultInput.value = String(prop.defaultValue);
			}
			defaultInput.addEventListener("input", () => {
				prop.defaultValue = defaultInput.value || null;
			});

			const removeBtn = row.createEl("button", {
				text: "×",
				cls: "obsidian-objects-prop-row__remove",
			});
			removeBtn.addEventListener("click", () => {
				draft.properties = draft.properties.filter(
					(p) => p.id !== prop.id
				);
				this.renderProperties(draft, container);
			});
		}

		const addBtn = container.createEl("button", {
			text: "+ Add property",
			cls: "obsidian-objects-prop-add",
		});
		addBtn.addEventListener("click", () => {
			draft.properties.push({
				id: newId(),
				name: "",
				type: "text",
				defaultValue: null,
				linkedTypeId: null,
			});
			this.renderProperties(draft, container);
		});
	}

	private async handleSave(): Promise<void> {
		const draft = this.draft;
		if (!draft) return;

		const trimmedName = draft.name.trim();
		if (!trimmedName) {
			new Notice("Object type needs a name.");
			return;
		}
		const pluralName = draft.pluralName.trim() || trimmedName + "s";
		const safePlural = safeFolderName(pluralName);
		if (!safePlural) {
			new Notice("Plural name cannot be used as a folder name.");
			return;
		}

		// Compose the destination folder path from the explicit pieces. For
		// sub-types the location is forced to the parent's folder by the UI.
		const targetFolderPath = joinPath(
			draft.locationPath || "",
			safePlural
		);

		const cleaned = draft.properties.map((p) => ({
			...p,
			name: p.name.trim(),
		}));
		if (cleaned.some((p) => !p.name)) {
			new Notice("Property names cannot be blank.");
			return;
		}
		const names = cleaned.map((p) => p.name.toLowerCase());
		if (new Set(names).size !== names.length) {
			new Notice("Property names must be unique.");
			return;
		}

		if (draft.existingId) {
			const type = this.manager.getTypeById(draft.existingId);
			if (!type) return;

			if (targetFolderPath !== type.folderPath) {
				// Block destructive name/location collisions before the
				// move starts — moveType would silently merge into an
				// existing folder otherwise.
				const occupant =
					this.app.vault.getAbstractFileByPath(targetFolderPath);
				if (occupant) {
					const kind =
						occupant instanceof TFile ? "file" : "folder";
					new Notice(
						`Cannot move: a ${kind} already exists at "${targetFolderPath}".`
					);
					return;
				}

				const impact = this.manager.getMoveImpact(draft.existingId);
				const oldParent = parentDir(type.folderPath);
				const isPureRename =
					oldParent === (draft.locationPath || "");
				const title = isPureRename
					? "Rename type folder?"
					: "Move type folder?";
				const body =
					`"${type.folderPath}" will become "${targetFolderPath}". ` +
					`${impact.fileCount} file(s) and ${impact.subfolderCount} ` +
					`subfolder(s) will move with it.`;
				const choice = await confirmAction(this.app, {
					title,
					body,
					confirmText: isPureRename ? "Rename" : "Move",
				});
				if (choice !== "confirm") return;
				try {
					await this.manager.moveType(
						draft.existingId,
						targetFolderPath
					);
				} catch (err) {
					new Notice(`Move failed: ${err}`);
					return;
				}
			}

			const preview = this.manager.previewPropertyChange(
				draft.existingId,
				cleaned
			);
			const destructive =
				preview.removed.length > 0 && preview.affectedFileCount > 0;
			let removeFromNotes = false;
			if (destructive) {
				const choice = await confirmAction(this.app, {
					title: "Remove property values from notes?",
					body: `${preview.removed.length} propert${
						preview.removed.length === 1 ? "y" : "ies"
					} will be removed from the type. ${preview.affectedFileCount} existing note(s) contain values for the removed propert${
						preview.removed.length === 1 ? "y" : "ies"
					}.`,
					extraButtons: [
						{ text: "Keep values in notes", value: "keep" },
					],
					confirmText: "Remove values",
				});
				if (choice === null || choice === "cancel") return;
				removeFromNotes = choice === "confirm";
			} else if (
				preview.added.length + preview.renamed.length > 0 &&
				preview.affectedFileCount > 0
			) {
				const choice = await confirmAction(this.app, {
					title: "Apply property changes?",
					body: `${preview.affectedFileCount} note(s) will be updated (${preview.added.length} added, ${preview.renamed.length} renamed).`,
					confirmText: "Apply",
				});
				if (choice !== "confirm") return;
			}
			await this.manager.updateType(
				draft.existingId,
				{
					name: trimmedName,
					pluralName,
					icon: draft.icon.trim() || "box",
					parentId: draft.parentId,
					properties: cleaned,
					showTags: draft.showTags ?? false,
					showAliases: draft.showAliases ?? false,
				},
				{ removeDeletedFromNotes: removeFromNotes }
			);
		} else {
			// New types: a same-named folder owned by another type is a hard
			// no. A bare folder at the same path is fine — we adopt it.
			const occupant =
				this.app.vault.getAbstractFileByPath(targetFolderPath);
			if (occupant instanceof TFile) {
				new Notice(
					`A file already exists at "${targetFolderPath}".`
				);
				return;
			}
			if (occupant instanceof TFolder) {
				const owner = this.manager.getTypeByFolder(targetFolderPath);
				if (owner) {
					new Notice(
						`Folder "${targetFolderPath}" is already registered as type "${owner.name}".`
					);
					return;
				}
			}

			try {
				await this.manager.createType({
					name: trimmedName,
					pluralName,
					icon: draft.icon.trim() || "box",
					folderPath: targetFolderPath,
					parentId: draft.parentId,
					properties: cleaned,
					showTags: draft.showTags ?? false,
					showAliases: draft.showAliases ?? false,
				});
			} catch (err) {
				new Notice(String(err));
				return;
			}
		}
		this.screen = "list";
		this.draft = null;
		this.render();
	}
}

/** Return the parent directory portion of a vault-relative path. */
function parentDir(path: string): string {
	const i = path.lastIndexOf("/");
	return i > 0 ? path.slice(0, i) : "";
}

interface TypeDraft {
	existingId?: string;
	name: string;
	pluralName: string;
	/** Parent folder containing the type's folder. Empty string = vault root. */
	locationPath: string;
	icon: string;
	parentId: string | null;
	properties: ObjectProperty[];
	showTags?: boolean;
	showAliases?: boolean;
}

function blankDraft(initialFolderPath = ""): TypeDraft {
	// Honour an initial folder path passed in by the caller (used when the
	// user opened the modal from a folder context menu): treat the picked
	// folder as the parent location.
	const locationPath = initialFolderPath
		? parentDirOfPath(initialFolderPath)
		: "";
	const pluralName = initialFolderPath
		? basenameOfPath(initialFolderPath)
		: "";
	return {
		name: "",
		pluralName,
		locationPath,
		icon: "box",
		parentId: null,
		properties: [],
		showTags: false,
		showAliases: false,
	};
}

function draftFromType(type: ObjectTypeDefinition): TypeDraft {
	return {
		existingId: type.id,
		name: type.name,
		pluralName: type.pluralName,
		locationPath: parentDirOfPath(type.folderPath),
		icon: type.icon,
		parentId: type.parentId ?? null,
		properties: type.properties.map((p) => ({ ...p })),
		showTags: type.showTags ?? false,
		showAliases: type.showAliases ?? false,
	};
}

function parentDirOfPath(path: string): string {
	const i = path.lastIndexOf("/");
	return i > 0 ? path.slice(0, i) : "";
}

function basenameOfPath(path: string): string {
	const i = path.lastIndexOf("/");
	return i >= 0 ? path.slice(i + 1) : path;
}
