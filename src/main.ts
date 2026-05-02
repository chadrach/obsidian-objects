import {
	Menu,
	MenuItem,
	Plugin,
	TFile,
	TFolder,
	WorkspaceLeaf,
	MarkdownView,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { DEFAULT_DATA, ObjectsPluginData } from "./types";
import { ObjectTypeManager } from "./objectTypeManager";
import { AtSuggest } from "./suggest/atSuggest";
import { ObjectTypeSettingsModal } from "./modals/objectTypeSettingsModal";
import { ChangeObjectTypeModal } from "./modals/changeObjectTypeModal";
import { LinkDecorator } from "./linkDecorator";
import { ObjectsSettingTab } from "./settingTab";
import { syncDailyNotesType } from "./dailyNotes";
import { buildLinkIconExtension } from "./cm/linkIconExtension";
import { MentionPopup } from "./mentionPopup";

/**
 * Entry point for the Obsidian Objects plugin.
 *
 * Responsibilities:
 *   - Load/save persisted data via `ObjectTypeManager`.
 *   - Register editor hooks: the `@` editor suggester for CodeMirror, a CM6
 *     view plugin for live-preview link icons, and a document-level
 *     `MentionPopup` that handles the Properties editor and Bases cells.
 *   - Add commands, context menus, and the settings tab.
 *   - Wire the link-icon decorator to the workspace (file-explorer, reading
 *     mode rendered links).
 *   - Intercept clicks on typed folders so the .base file opens instead of
 *     the folder expanding.
 *   - Keep the Daily Notes managed type in sync with the user's
 *     `daily-notes` core plugin configuration.
 */
export default class ObjectsPlugin extends Plugin {
	manager!: ObjectTypeManager;
	linkDecorator: LinkDecorator | null = null;
	private suggest: AtSuggest | null = null;
	private mentionPopup: MentionPopup | null = null;

	async onload(): Promise<void> {
		const loaded = (await this.loadData()) as ObjectsPluginData | null;
		this.manager = new ObjectTypeManager(
			this.app,
			loaded ?? DEFAULT_DATA,
			(data) => this.saveData(data)
		);

		// --- Editor suggester (CodeMirror) -----------------------------
		this.suggest = new AtSuggest(this.app, this.manager);
		this.registerEditorSuggest(this.suggest);

		// --- CodeMirror live-preview icon extension --------------------
		this.registerEditorExtension(
			buildLinkIconExtension(this.app, this.manager)
		);

		// --- Mention popup (Properties editor, Bases cells) ------------
		this.mentionPopup = new MentionPopup(this.app, this.manager);
		this.mentionPopup.attach();
		this.register(() => this.mentionPopup?.detach());

		// --- Reading-mode + nav-pane icon decorations ------------------
		this.linkDecorator = new LinkDecorator(this.app, this.manager);
		this.registerMarkdownPostProcessor(
			this.linkDecorator.readingModePostProcessor
		);
		this.app.workspace.onLayoutReady(() => {
			this.linkDecorator?.observeWorkspace();
			this.linkDecorator?.decorateAll();
		});
		this.register(() => this.linkDecorator?.disconnect());
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.linkDecorator?.decorateAll();
			})
		);
		this.register(
			this.manager.onChange(() => {
				this.linkDecorator?.decorateAll();
				this.refreshOpenEditorViews();
			})
		);

		// --- File / folder context menu -------------------------------
		// `file-menu` fires for every file context menu Obsidian shows: the
		// file explorer, internal-link right-clicks, and tab right-clicks
		// (with `source` distinguishing them, but the same items work for
		// all three).
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					this.addFolderMenuItems(menu, file);
				} else if (
					file instanceof TFile &&
					file.extension === "md"
				) {
					this.addFileMenuItems(menu, file);
				}
			})
		);

		// --- Folder click → base file ---------------------------------
		// Obsidian's file-explorer toggles folder collapse on `click` in the
		// bubble phase, so we register a capture-phase listener that runs
		// before any other and `stopImmediatePropagation` if we own this
		// folder. The middle-mouse case goes through the same path, matching
		// the approach used by the Folder Notes plugin.
		this.registerDomEvent(
			document,
			"click",
			(evt) => this.handleFolderClick(evt),
			{ capture: true }
		);
		this.registerDomEvent(
			document,
			"auxclick",
			(evt) => {
				if (evt.button === 2) return;
				this.handleFolderClick(evt);
			},
			{ capture: true }
		);

		// --- Ribbon ---------------------------------------------------
		this.addRibbonIcon("layers", "Open Object Type Settings", () => {
			this.openTypeSettings();
		});

		// --- Commands -------------------------------------------------
		this.addCommand({
			id: "open-object-type-settings",
			name: "Open Object Type Settings",
			callback: () => this.openTypeSettings(),
		});
		this.addCommand({
			id: "create-new-object",
			name: "Create new object",
			callback: () => this.openTypeSettings(),
		});
		this.addCommand({
			id: "insert-object-mention",
			name: "Insert object mention",
			editorCallback: (editor) => {
				const cursor = editor.getCursor();
				const trigger = this.manager.getSettings().triggerChar || "@";
				editor.replaceRange(trigger, cursor);
				editor.setCursor({ line: cursor.line, ch: cursor.ch + 1 });
			},
		});

		// --- Settings tab --------------------------------------------
		this.addSettingTab(new ObjectsSettingTab(this.app, this));

		// --- Daily Notes integration ---------------------------------
		this.app.workspace.onLayoutReady(() => {
			void this.refreshDailyNotesType();
			// Register Obsidian property types after layout is ready so
			// metadataTypeManager has finished its own initialization.
			this.manager.registerObsidianPropertyTypes();
		});
	}

	onunload(): void {
		this.linkDecorator?.disconnect();
		this.mentionPopup?.detach();
	}

	// ---------- public API used by sub-components ----------

	openTypeSettings(typeId?: string, folderPath?: string): void {
		new ObjectTypeSettingsModal(this.app, this.manager, {
			initialTypeId: typeId,
			initialFolderPath: folderPath,
		}).open();
	}

	async refreshDailyNotesType(): Promise<void> {
		try {
			await syncDailyNotesType(this.app, this.manager);
		} catch (err) {
			console.warn("Daily Notes sync failed", err);
		}
	}

	// ---------- private helpers ----------

	private addFolderMenuItems(menu: Menu, folder: TFolder): void {
		const type = this.manager.getTypeByFolder(folder.path);
		menu.addItem((item: MenuItem) => {
			item
				.setTitle(
					type ? "Edit Object Type Settings" : "Object Type Settings"
				)
				.setIcon("settings-2")
				.onClick(() => {
					this.openTypeSettings(type?.id, folder.path);
				});
		});
		if (type) {
			menu.addItem((item: MenuItem) => {
				item
					.setTitle("Open type overview (.base)")
					.setIcon("layout-grid")
					.onClick(() => void this.openBaseFor(type.id));
			});
		}
	}

	/**
	 * Add a "Change object type" submenu to the context menu for a markdown
	 * file. Hidden when no object types are defined yet.
	 *
	 * The auto-managed Daily Notes type isn't offered as a destination — its
	 * folder/format come from the core Daily Notes plugin and changing a
	 * note's type to it would just confuse the integration.
	 */
	private addFileMenuItems(menu: Menu, file: TFile): void {
		const types = this.manager
			.getTypes()
			.filter((t) => t.managed !== "daily-notes");
		if (types.length === 0) return;
		const currentType = this.manager.getTypeForPath(file.path);

		menu.addItem((item: MenuItem) => {
			item.setTitle("Change object type").setIcon("layers");
			const submenu = (
				item as MenuItem & { setSubmenu?: () => Menu }
			).setSubmenu?.();
			if (!submenu) return;
			for (const type of types) {
				submenu.addItem((sub: MenuItem) => {
					sub.setTitle(type.name).setIcon(type.icon || "box");
					if (currentType?.id === type.id) {
						sub.setChecked(true);
					}
					sub.onClick(() => {
						new ChangeObjectTypeModal(
							this.app,
							this.manager,
							file,
							type
						).open();
					});
				});
			}
		});
	}

	private async openBaseFor(typeId: string): Promise<void> {
		const type = this.manager.getTypeById(typeId);
		if (!type) return;
		const file = this.app.vault.getAbstractFileByPath(type.basePath);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf().openFile(file);
		}
	}

	/**
	 * Intercepts clicks on typed folder rows in the file explorer and opens
	 * the associated .base file instead of expanding the folder. The
	 * collapse chevron is left alone so the user can still expand/collapse
	 * the tree when they want to. We listen in capture phase and call
	 * `stopImmediatePropagation` before Obsidian's own click handler runs.
	 */
	private handleFolderClick(evt: MouseEvent): void {
		if (evt.button !== 0 && evt.type !== "auxclick") return;
		if (!this.manager.getSettings().folderClickOpensBase) return;
		const target = evt.target as HTMLElement | null;
		if (!target) return;
		const folderTitle = target.closest(
			".nav-folder-title"
		) as HTMLElement | null;
		if (!folderTitle) return;
		// Let the user still use the collapse chevron. Different Obsidian
		// versions ship slightly different markup for it, so accept either
		// the legacy `.nav-folder-collapse-indicator` or the newer
		// `.collapse-icon` class used everywhere else.
		if (
			target.closest(".collapse-icon") ||
			target.closest(".nav-folder-collapse-indicator")
		) {
			return;
		}
		const path = folderTitle.dataset.path;
		if (!path) return;
		const type = this.manager.getTypeByFolder(path);
		if (!type) return;
		const base = this.app.vault.getAbstractFileByPath(type.basePath);
		if (!(base instanceof TFile)) return;
		// Order matters: stopImmediatePropagation has to fire first so any
		// other capture-phase listeners on the same element (Obsidian's own
		// toggle) don't run after this one.
		evt.stopImmediatePropagation();
		evt.preventDefault();
		evt.stopPropagation();
		void this.app.workspace.getLeaf().openFile(base);
	}

	/**
	 * Force a re-decoration in every open markdown editor — used after the
	 * type list changes so existing live-preview viewports pick up new icons
	 * without waiting for the next viewport scroll.
	 */
	private refreshOpenEditorViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			cm?.dispatch({});
		}
	}

	/** Unused convenience, kept for external callers / future code. */
	getSuggest(): AtSuggest | null {
		return this.suggest;
	}

	getExplorerLeaves(): WorkspaceLeaf[] {
		return this.app.workspace.getLeavesOfType("file-explorer");
	}
}
