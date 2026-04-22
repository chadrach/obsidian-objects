import {
	Menu,
	MenuItem,
	Plugin,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from "obsidian";
import { DEFAULT_DATA, ObjectsPluginData } from "./types";
import { ObjectTypeManager } from "./objectTypeManager";
import { AtSuggest } from "./suggest/atSuggest";
import { ObjectTypeSettingsModal } from "./modals/objectTypeSettingsModal";
import { LinkDecorator } from "./linkDecorator";
import { ObjectsSettingTab } from "./settingTab";
import { syncDailyNotesType } from "./dailyNotes";

/**
 * Entry point for the Obsidian Objects plugin.
 *
 * Responsibilities:
 *   - Load/save persisted data via `ObjectTypeManager`.
 *   - Register the `@` editor suggester.
 *   - Add commands, context menus, and the settings tab.
 *   - Wire the link-icon decorator to the workspace.
 *   - Keep the Daily Notes managed type in sync with the user's
 *     `daily-notes` core plugin configuration.
 */
export default class ObjectsPlugin extends Plugin {
	manager!: ObjectTypeManager;
	linkDecorator: LinkDecorator | null = null;
	private suggest: AtSuggest | null = null;

	async onload(): Promise<void> {
		const loaded = (await this.loadData()) as ObjectsPluginData | null;
		this.manager = new ObjectTypeManager(
			this.app,
			loaded ?? DEFAULT_DATA,
			(data) => this.saveData(data)
		);

		// --- Editor suggester ------------------------------------------
		this.suggest = new AtSuggest(this.app, this.manager);
		this.registerEditorSuggest(this.suggest);

		// --- Link + folder icon decorations ---------------------------
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
			})
		);

		// --- Folder context menu --------------------------------------
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					this.addFolderMenuItems(menu, file);
				}
			})
		);

		// --- Folder click → base file ---------------------------------
		this.registerDomEvent(document, "click", (evt) =>
			this.handleFolderClick(evt)
		);

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
		});
	}

	onunload(): void {
		this.linkDecorator?.disconnect();
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

	private async openBaseFor(typeId: string): Promise<void> {
		const type = this.manager.getTypeById(typeId);
		if (!type) return;
		const file = this.app.vault.getAbstractFileByPath(type.basePath);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf().openFile(file);
		}
	}

	/**
	 * Intercepts clicks on typed folders in the file explorer and opens the
	 * associated .base file instead of expanding the folder, mimicking the
	 * Folder Notes plugin's behavior.
	 */
	private handleFolderClick(evt: MouseEvent): void {
		if (!this.manager.getSettings().folderClickOpensBase) return;
		const target = evt.target as HTMLElement | null;
		if (!target) return;
		const folderTitle = target.closest(
			".nav-folder-title"
		) as HTMLElement | null;
		if (!folderTitle) return;
		// Let the user still use the collapse chevron.
		if ((evt.target as HTMLElement).closest(".nav-folder-collapse-indicator")) {
			return;
		}
		const path = folderTitle.dataset.path;
		if (!path) return;
		const type = this.manager.getTypeByFolder(path);
		if (!type) return;
		const base = this.app.vault.getAbstractFileByPath(type.basePath);
		if (!(base instanceof TFile)) return;
		evt.preventDefault();
		evt.stopPropagation();
		void this.app.workspace.getLeaf().openFile(base);
	}

	/** Unused convenience, kept for external callers / future code. */
	getSuggest(): AtSuggest | null {
		return this.suggest;
	}

	getExplorerLeaves(): WorkspaceLeaf[] {
		return this.app.workspace.getLeavesOfType("file-explorer");
	}
}
