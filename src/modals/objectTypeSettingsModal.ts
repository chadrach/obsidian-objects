import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	Setting,
	TFile,
	TFolder,
	setIcon,
	setTooltip,
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
import { trackVisualViewportForModal } from "../mobileViewport";

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
	private keyboardCleanup: (() => void) | null = null;

	constructor(
		app: App,
		private readonly manager: ObjectTypeManager,
		private readonly opts: {
			initialTypeId?: string;
			initialFolderPath?: string;
			openNew?: boolean;
		} = {}
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("obsidian-objects-modal");
		this.keyboardCleanup = trackVisualViewportForModal(this.modalEl);
		if (this.opts.openNew) {
			this.draft = blankDraft();
			this.screen = "edit";
		} else if (this.opts.initialTypeId) {
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

	onClose(): void {
		this.keyboardCleanup?.();
		this.keyboardCleanup = null;
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
				let needsLocationPicker = false;
				for (const issue of issues) {
					// For a sub-type with a missing folder the correct
					// location is fixed (inside the parent's folder), so
					// the user can't re-point it. Surface a friendlier
					// message and let Save recreate it automatically.
					if (
						issue.missing === "folder" &&
						draft.parentId
					) {
						list.createEl("li", {
							text: `Folder "${issue.expectedPath}" no longer exists. It will be recreated in its proper location the next time you save changes to this type.`,
						});
					} else {
						list.createEl("li", { text: issue.detail });
						if (issue.missing === "folder") {
							needsLocationPicker = true;
						}
					}
				}
				if (needsLocationPicker) {
					const fix = banner.createDiv();
					new ButtonComponent(fix)
						.setButtonText("Pick replacement location…")
						.onClick(() =>
							this.openLocationPicker(draft, () =>
								this.render()
							)
						);
				}
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
						updateLocationVisual();
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
						updateLocationVisual();
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
		let adoptHintEl: HTMLElement;
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
				adoptHintEl?.hide();
			} else {
				const path = draft.locationPath || "";
				locationDisplay.setText(
					path ? `Current: ${path}` : "Vault root"
				);
				locationPickerBtn.setDisabled(false);

				// For new types: show a hint when the composed folder path
				// already exists so the user knows it can be adopted.
				if (!draft.existingId && adoptHintEl) {
					const rawPlural =
						draft.pluralName.trim() ||
						(draft.name.trim()
							? draft.name.trim() + "s"
							: "");
					const safePlural = rawPlural
						? safeFolderName(rawPlural)
						: null;
					const targetPath = safePlural
						? joinPath(path, safePlural)
						: null;
					const occupant = targetPath
						? this.app.vault.getAbstractFileByPath(targetPath)
						: null;
					if (
						occupant instanceof TFolder &&
						!this.manager.getTypeByFolder(targetPath!)
					) {
						adoptHintEl.setText(
							`Folder "${targetPath}" already exists and will be adopted — existing notes will not be modified.`
						);
						adoptHintEl.show();
					} else {
						adoptHintEl.hide();
					}
				}
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
		adoptHintEl = locationSetting.descEl.createDiv({
			cls: "obsidian-objects-location-adopt-hint",
		});
		adoptHintEl.hide();
		locationSetting.addButton((b) => {
			locationPickerBtn = b
				.setButtonText("Pick location…")
				.onClick(() =>
					this.openLocationPicker(draft, updateLocationVisual)
				);
		});
		updateLocationVisual();

		const iconDesc = document.createDocumentFragment();
		iconDesc.append(
			'Lucide icon name, e.g. "user", "building", "calendar". Browse icons at '
		);
		const iconLink = document.createElement("a");
		iconLink.textContent = "lucide.dev";
		iconLink.href = "https://lucide.dev/icons/";
		iconLink.target = "_blank";
		iconLink.rel = "noopener";
		iconDesc.append(iconLink);
		iconDesc.append(".");
		new Setting(this.contentEl)
			.setName("Icon")
			.setDesc(iconDesc)
			.addText((t) =>
				t
					.setValue(draft.icon)
					.setPlaceholder("box")
					.onChange((v) => {
						draft.icon = v;
					})
			);

		new Setting(this.contentEl)
			.setName("Description")
			.setDesc("Your description for this object type.")
			.addTextArea((t) =>
				t
					.setValue(draft.description)
					.setPlaceholder("Optional description…")
					.onChange((v) => {
						draft.description = v;
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
		const typePropertyName =
			this.manager.getSettings().typePropertyName;
		new Setting(reserved)
			.setName(`Include \`${typePropertyName}\` property`)
			.setDesc(
				`When creating a new note of this type, write its type name into the \`${typePropertyName}\` frontmatter key. Useful for Dataview or custom Bases queries that span multiple folders.`
			)
			.addToggle((t) =>
				t
					.setValue(draft.showTypeProperty ?? false)
					.onChange((v) => {
						draft.showTypeProperty = v;
					})
			);
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
		new Setting(reserved)
			.setName("Add H1 title heading")
			.setDesc(
				"When creating a new note of this type, insert `# Note Title` as the first line of the note body. Also added to existing notes (by filename) when the auto-apply prompt runs, if no H1 is already present."
			)
			.addToggle((t) =>
				t.setValue(draft.addH1Title ?? false).onChange((v) => {
					draft.addH1Title = v;
				})
			);
		new Setting(reserved)
			.setName("Extend to subfolders")
			.setDesc(
				"When enabled, notes in any subfolder of this type's folder are treated as belonging to this type — unless that subfolder is registered as its own object type."
			)
			.addToggle((t) =>
				t.setValue(draft.extendToSubfolders ?? false).onChange((v) => {
					draft.extendToSubfolders = v;
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
			// Tap-to-show on mobile is handled by Obsidian's setTooltip;
			// pure aria-label only fires on hover, which doesn't exist on
			// touch devices. Tapping the icon now toggles the tooltip too
			// so the warning is reachable on mobile.
			collisionIcon.addEventListener("click", (evt) => {
				evt.stopPropagation();
				const tip = collisionIcon.getAttribute("data-tooltip-text");
				if (tip) new Notice(tip);
			});

			const updateCollision = () => {
				const name = nameInput.value.trim();
				if (!name) {
					collisionIcon.removeClass("is-visible");
					collisionIcon.removeAttribute("data-tooltip-text");
					setTooltip(collisionIcon, "");
					return;
				}
				const lower = name.toLowerCase();
				if (lower === "tags" || lower === "aliases") {
					const message =
						`"${name}" is reserved by Obsidian. ` +
						`Use the "Show ${lower === "tags" ? "Tags" : "Aliases"} property by default" toggle above instead — ` +
						`saving with this name will be rejected.`;
					setTooltip(collisionIcon, message);
					collisionIcon.setAttribute(
						"data-tooltip-text",
						message
					);
					collisionIcon.addClass("is-visible");
					collisionIcon.addClass("is-error");
					return;
				}
				collisionIcon.removeClass("is-error");
				// Get all child types of the current type (if editing)
				const childTypeIds = new Set<string>();
				if (draft.existingId) {
					for (const t of this.manager.getTypes()) {
						if (t.parentId === draft.existingId) {
							childTypeIds.add(t.id);
						}
					}
				}
				const conflicts = this.manager
					.getTypes()
					.filter((t) => t.id !== draft.existingId)
					.filter((t) => !childTypeIds.has(t.id))
					.filter((t) =>
						this.manager
							.getEffectiveProperties(t)
							.some(
								(p) =>
									p.name.toLowerCase() === lower
							)
					);
				if (conflicts.length > 0) {
					const typeList = conflicts
						.map((t) => t.name)
						.join(", ");
					const message =
						`"${name}" is also defined on: ${typeList}. ` +
						`Sharing a name means Bases views can display both types' values in the same column. ` +
						`Changes made to the property type will apply globally to all properties of the same name and may result in syntax errors.`;
					setTooltip(collisionIcon, message);
					collisionIcon.setAttribute(
						"data-tooltip-text",
						message
					);
					collisionIcon.addClass("is-visible");
				} else {
					collisionIcon.removeClass("is-visible");
					collisionIcon.removeAttribute("data-tooltip-text");
					setTooltip(collisionIcon, "");
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
				const next = typeSelect.value as PropertyType;
				// Clear the "current date/time" sentinel when the user changes
				// a date/datetime property to a different type — @now isn't a
				// valid or meaningful default for text, number, checkbox, etc.
				if (
					prop.defaultValue === "@now" &&
					next !== "date" &&
					next !== "datetime"
				) {
					prop.defaultValue = null;
				}
				prop.type = next;
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
				// Self-links are allowed — e.g. a Person type can have a
				// "Family" property that points back at Person — so we don't
				// exclude the type being edited from the dropdown.
				for (const t of this.manager.getTypes()) {
					if (t.managed === "daily-notes") continue;
					const label =
						t.id === draft.existingId
							? `${t.name} (this type)`
							: t.name;
					const opt = linkSelect.createEl("option", {
						text: label,
						value: t.id,
					});
					if (prop.linkedTypeId === t.id) opt.selected = true;
				}
				linkSelect.addEventListener("change", () => {
					prop.linkedTypeId = linkSelect.value || null;
				});
			}

			if (prop.type === "date" || prop.type === "datetime") {
				// For date / datetime we offer three modes via a select:
				//   • No default   → defaultValue = null
				//   • Current date/time → defaultValue = "@now" (resolved at
				//     note-creation time to the actual local date/time)
				//   • Fixed value  → defaultValue = user-supplied string
				const wrap = row.createDiv({
					cls: "obsidian-objects-prop-row__date-default",
				});
				const modeSelect = wrap.createEl("select");
				modeSelect.createEl("option", {
					text: "No default",
					value: "",
				});
				modeSelect.createEl("option", {
					text: "Current date/time",
					value: "@now",
				});
				modeSelect.createEl("option", {
					text: "Fixed value",
					value: "fixed",
				});

				const fixedInput = wrap.createEl("input", {
					type: "text",
				});
				fixedInput.placeholder =
					prop.type === "datetime"
						? "YYYY-MM-DDTHH:mm"
						: "YYYY-MM-DD";

				// Set initial state from the stored defaultValue.
				if (prop.defaultValue === "@now") {
					modeSelect.value = "@now";
					fixedInput.hidden = true;
				} else if (
					prop.defaultValue !== null &&
					prop.defaultValue !== undefined &&
					prop.defaultValue !== ""
				) {
					modeSelect.value = "fixed";
					fixedInput.value = String(prop.defaultValue);
					fixedInput.hidden = false;
				} else {
					modeSelect.value = "";
					fixedInput.hidden = true;
				}

				modeSelect.addEventListener("change", () => {
					if (modeSelect.value === "@now") {
						prop.defaultValue = "@now";
						fixedInput.hidden = true;
					} else if (modeSelect.value === "fixed") {
						prop.defaultValue = fixedInput.value || null;
						fixedInput.hidden = false;
						fixedInput.focus();
					} else {
						prop.defaultValue = null;
						fixedInput.hidden = true;
					}
				});
				fixedInput.addEventListener("input", () => {
					prop.defaultValue = fixedInput.value || null;
				});
			} else {
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
			}

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
		// Reserved-name guard: Obsidian keys "tags" and "aliases" off the
		// frontmatter property type, so a user-defined property with either
		// name conflicts with the reserved Tags / Aliases types and the
		// per-type toggle. Ask the user to use the toggle instead.
		const reserved = cleaned.find(
			(p) =>
				p.name.toLowerCase() === "tags" ||
				p.name.toLowerCase() === "aliases"
		);
		if (reserved) {
			new Notice(
				`"${reserved.name}" is reserved by Obsidian. ` +
					`Remove this property and use the "Show ${
						reserved.name.toLowerCase() === "tags"
							? "Tags"
							: "Aliases"
					} property by default" toggle above instead.`
			);
			return;
		}

		if (draft.existingId) {
			const type = this.manager.getTypeById(draft.existingId);
			if (!type) return;

			if (targetFolderPath !== type.folderPath) {
				const occupant =
					this.app.vault.getAbstractFileByPath(targetFolderPath);

				if (occupant instanceof TFile) {
					new Notice(
						`Cannot move: a file already exists at "${targetFolderPath}".`
					);
					return;
				}

				if (occupant instanceof TFolder) {
					const owner =
						this.manager.getTypeByFolder(targetFolderPath);
					if (owner) {
						new Notice(
							`Cannot move: "${targetFolderPath}" is already registered as type "${owner.name}".`
						);
						return;
					}
					// Bare existing folder — offer to merge/adopt it.
					const impact = this.manager.getMoveImpact(draft.existingId);
					const choice = await confirmAction(this.app, {
						title: "Adopt existing folder?",
						body:
							`A folder named "${targetFolderPath}" already exists. ` +
							`${impact.fileCount > 0 ? `${impact.fileCount} note(s) from "${type.folderPath}" will be moved into it. ` : `"${type.folderPath}" will be removed. `}` +
							`Existing notes in "${targetFolderPath}" will not be modified.`,
						confirmText: "Adopt folder",
					});
					if (choice !== "confirm") return;
				} else {
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
				}
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

			// Check if the showTypeProperty flag changed and offer to
			// bulk-update existing notes to match.
			const prevShowTypeProperty = type.showTypeProperty ?? false;
			const newShowTypeProperty = draft.showTypeProperty ?? false;
			let typePropertyAction: "add" | "remove" | undefined;
			if (
				prevShowTypeProperty !== newShowTypeProperty &&
				preview.affectedFileCount > 0
			) {
				const typePropertyName =
					this.manager.getSettings().typePropertyName;
				if (newShowTypeProperty) {
					const choice = await confirmAction(this.app, {
						title: `Add "${typePropertyName}" to existing notes?`,
						body: `${preview.affectedFileCount} existing note(s) can be updated to include a "${typePropertyName}" property identifying them as ${trimmedName}.`,
						extraButtons: [
							{ text: "New notes only", value: "skip" },
						],
						confirmText: "Update existing notes",
					});
					if (choice === null || choice === "cancel") return;
					if (choice === "confirm") typePropertyAction = "add";
				} else {
					const choice = await confirmAction(this.app, {
						title: `Remove "${typePropertyName}" from existing notes?`,
						body: `${preview.affectedFileCount} existing note(s) currently carry a "${typePropertyName}" property.`,
						extraButtons: [
							{ text: "New notes only", value: "skip" },
						],
						confirmText: "Remove from existing notes",
					});
					if (choice === null || choice === "cancel") return;
					if (choice === "confirm") typePropertyAction = "remove";
				}
			}

			await this.manager.updateType(
				draft.existingId,
				{
					name: trimmedName,
					pluralName,
					icon: draft.icon.trim() || "box",
					parentId: draft.parentId,
					properties: cleaned,
					showTypeProperty: newShowTypeProperty,
					showTags: draft.showTags ?? false,
					showAliases: draft.showAliases ?? false,
					addH1Title: draft.addH1Title ?? false,
					extendToSubfolders: draft.extendToSubfolders ?? false,
					description: draft.description,
				},
				{ removeDeletedFromNotes: removeFromNotes, typePropertyAction }
			);
		} else {
			// New types: a same-named folder owned by another type is a hard
			// no. A bare folder at the same path can be adopted — ask first.
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
				// Existing bare folder — confirm adoption before proceeding.
				const choice = await confirmAction(this.app, {
					title: "Adopt existing folder?",
					body:
						`A folder named "${targetFolderPath}" already exists. ` +
						`Register it as the "${trimmedName}" object type? ` +
						`Existing notes will not be modified.`,
					confirmText: "Adopt folder",
				});
				if (choice !== "confirm") return;
			}

			try {
				await this.manager.createType({
					name: trimmedName,
					pluralName,
					icon: draft.icon.trim() || "box",
					folderPath: targetFolderPath,
					parentId: draft.parentId,
					properties: cleaned,
					showTypeProperty: draft.showTypeProperty ?? false,
					showTags: draft.showTags ?? false,
					showAliases: draft.showAliases ?? false,
					addH1Title: draft.addH1Title ?? false,
					extendToSubfolders: draft.extendToSubfolders ?? false,
					description: draft.description,
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
	showTypeProperty?: boolean;
	showTags?: boolean;
	showAliases?: boolean;
	addH1Title?: boolean;
	extendToSubfolders?: boolean;
	description: string;
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
		showTypeProperty: false,
		showTags: false,
		showAliases: false,
		addH1Title: false,
		extendToSubfolders: false,
		description: "",
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
		showTypeProperty: type.showTypeProperty ?? false,
		showTags: type.showTags ?? false,
		showAliases: type.showAliases ?? false,
		addH1Title: type.addH1Title ?? false,
		extendToSubfolders: type.extendToSubfolders ?? false,
		description: type.description ?? "",
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
