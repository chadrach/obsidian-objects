import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	Setting,
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

const PROPERTY_TYPES: Array<{ value: PropertyType; label: string }> = [
	{ value: "text", label: "Text" },
	{ value: "list", label: "List" },
	{ value: "number", label: "Number" },
	{ value: "checkbox", label: "Checkbox" },
	{ value: "date", label: "Date" },
	{ value: "datetime", label: "Datetime" },
	{ value: "tags", label: "Tags" },
	{ value: "aliases", label: "Aliases" },
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

		const broken = this.manager.getBrokenReferences();
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
		const types = this.manager.getTypes();
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
					.setButtonText("Pick replacement folder…")
					.onClick(() => this.openFolderPicker(draft));
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
			.setDesc("Used as the folder name by default.")
			.addText((t) =>
				t
					.setPlaceholder("People")
					.setValue(draft.pluralName)
					.onChange((v) => {
						draft.pluralName = v;
					})
			);

		const locationSetting = new Setting(this.contentEl)
			.setName("Object Location")
			.setDesc(
				draft.existingId
					? "Vault folder containing notes of this type. Changing this will move the folder and every nested note."
					: "Vault folder for new notes of this type. Pick an existing folder or create a new one below."
			);
		const locationDisplay = locationSetting.descEl.createDiv({
			cls: "obsidian-objects-location-current",
			text: draft.folderPath
				? `Current: ${draft.folderPath}`
				: "Not set yet — using the plural name.",
		});
		locationSetting.addButton((b) =>
			b
				.setButtonText("Pick folder…")
				.onClick(() => this.openFolderPicker(draft, locationDisplay))
		);
		locationSetting.addButton((b) =>
			b.setButtonText("New folder…").onClick(async () => {
				const result = await promptForFolderName(
					this.app,
					draft.folderPath
				);
				if (result === null) return;
				draft.folderPath = result;
				draft.folderPathDirty = true;
				locationDisplay.setText(`Current: ${result}`);
			})
		);

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

		new Setting(this.contentEl)
			.setName("Sub-type of")
			.setDesc(
				"Parent object type. Sub-type folders are nested inside the parent and inherit its properties."
			)
			.addDropdown((d) => {
				d.addOption("", "— None (top-level type) —");
				for (const t of this.manager.getTypes()) {
					if (t.id === draft.existingId) continue;
					d.addOption(t.id, this.manager.getQualifiedName(t));
				}
				d.setValue(draft.parentId ?? "");
				d.onChange((v) => {
					draft.parentId = v || null;
				});
			});

		this.contentEl.createEl("h3", { text: "Properties" });
		const propsEl = this.contentEl.createDiv({
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

	private openFolderPicker(
		draft: TypeDraft,
		display?: HTMLElement
	): void {
		new FolderPickerModal(
			this.app,
			(folder) => {
				draft.folderPath = folder.path === "" ? "/" : folder.path;
				draft.folderPathDirty = true;
				if (display) {
					display.setText(`Current: ${draft.folderPath}`);
				}
			},
			{
				title: "Select Object Location…",
				filter: (f: TFolder) => {
					// Don't let a sub-type live above its parent in the tree.
					if (!draft.parentId) return true;
					const parent = this.manager.getTypeById(draft.parentId);
					if (!parent) return true;
					return (
						f.path === parent.folderPath ||
						f.path.startsWith(parent.folderPath + "/")
					);
				},
			}
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
		if (!draft.name.trim()) {
			new Notice("Object type needs a name.");
			return;
		}
		const pluralName = draft.pluralName.trim() || draft.name.trim() + "s";
		const folderPath =
			safeFolderName(draft.folderPath) ||
			this.computeDefaultFolder(draft.parentId, pluralName);

		// Sanity: no empty property names; no duplicate names.
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
			// Folder relocation must be confirmed first so we don't surprise
			// the user by moving dozens of files behind a property change.
			const type = this.manager.getTypeById(draft.existingId);
			const folderChanged =
				draft.folderPathDirty &&
				type &&
				folderPath !== type.folderPath;
			if (folderChanged) {
				const impact = this.manager.getMoveImpact(draft.existingId);
				const choice = await confirmAction(this.app, {
					title: "Move object folder?",
					body: `Move "${type!.folderPath}" to "${folderPath}"? ${impact.fileCount} file(s) and ${impact.subfolderCount} subfolder(s) will move with it.`,
					confirmText: "Move",
				});
				if (choice !== "confirm") return;
				try {
					await this.manager.moveType(
						draft.existingId,
						folderPath
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
						{
							text: "Keep values in notes",
							value: "keep",
						},
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
					name: draft.name.trim(),
					pluralName,
					icon: draft.icon.trim() || "box",
					parentId: draft.parentId,
					properties: cleaned,
				},
				{ removeDeletedFromNotes: removeFromNotes }
			);
		} else {
			try {
				await this.manager.createType({
					name: draft.name.trim(),
					pluralName,
					icon: draft.icon.trim() || "box",
					folderPath,
					parentId: draft.parentId,
					properties: cleaned,
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

	private computeDefaultFolder(
		parentId: string | null | undefined,
		pluralName: string
	): string {
		if (parentId) {
			const parent = this.manager.getTypeById(parentId);
			if (parent) return joinPath(parent.folderPath, pluralName);
		}
		return pluralName;
	}
}

interface TypeDraft {
	existingId?: string;
	name: string;
	pluralName: string;
	folderPath: string;
	icon: string;
	parentId: string | null;
	properties: ObjectProperty[];
	/** True once the user has explicitly chosen a new location. */
	folderPathDirty?: boolean;
}

function blankDraft(folderPath = ""): TypeDraft {
	return {
		name: "",
		pluralName: "",
		folderPath,
		icon: "box",
		parentId: null,
		properties: [],
	};
}

function draftFromType(type: ObjectTypeDefinition): TypeDraft {
	return {
		existingId: type.id,
		name: type.name,
		pluralName: type.pluralName,
		folderPath: type.folderPath,
		icon: type.icon,
		parentId: type.parentId ?? null,
		properties: type.properties.map((p) => ({ ...p })),
	};
}

/**
 * Tiny modal that asks for a folder path string. Used when the user wants
 * to *create* (rather than adopt) a folder. Returns null if cancelled.
 */
function promptForFolderName(
	app: App,
	defaultValue: string
): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new (class extends Modal {
			private value = defaultValue;
			private resolved = false;
			onOpen(): void {
				this.titleEl.setText("New folder path");
				new Setting(this.contentEl)
					.setName("Vault-relative path")
					.addText((t) =>
						t
							.setValue(this.value)
							.setPlaceholder("People")
							.onChange((v) => {
								this.value = v;
							})
					);
				new Setting(this.contentEl)
					.addButton((b) =>
						b
							.setButtonText("Cancel")
							.onClick(() => this.finish(null))
					)
					.addButton((b) =>
						b
							.setButtonText("Use this path")
							.setCta()
							.onClick(() => this.finish(this.value.trim()))
					);
			}
			onClose(): void {
				if (!this.resolved) resolve(null);
			}
			private finish(value: string | null) {
				this.resolved = true;
				resolve(value);
				this.close();
			}
		})(app);
		modal.open();
	});
}
