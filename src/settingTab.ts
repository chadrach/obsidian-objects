import { App, PluginSettingTab, Setting } from "obsidian";
import type ObjectsPlugin from "./main";

/**
 * Plugin-wide settings surfaced under Settings → Community Plugins. Object
 * type definitions themselves live in the Object Type Settings modal, not
 * here — this tab is purely for global toggles.
 */
export class ObjectsSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: ObjectsPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.manager.getSettings();

		new Setting(containerEl)
			.setName("Trigger character")
			.setDesc(
				"Typing this character in the editor opens the object mention menu."
			)
			.addText((t) =>
				t
					.setValue(settings.triggerChar)
					.setPlaceholder("@")
					.onChange(async (v) => {
						await this.plugin.manager.updateSettings({
							triggerChar: v || "@",
						});
					})
			);

		new Setting(containerEl)
			.setName("Type property name")
			.setDesc(
				"Frontmatter key written on every object note identifying its type (and sub-type, slash-separated)."
			)
			.addText((t) =>
				t
					.setValue(settings.typePropertyName)
					.setPlaceholder("Object-Type")
					.onChange(async (v) => {
						await this.plugin.manager.updateSettings({
							typePropertyName: v || "Object-Type",
						});
					})
			);

		new Setting(containerEl)
			.setName("Show icons on typed links")
			.setDesc(
				"Prepend the object type's icon to wikilinks and navigation rows."
			)
			.addToggle((t) =>
				t.setValue(settings.showLinkIcons).onChange(async (v) => {
					await this.plugin.manager.updateSettings({
						showLinkIcons: v,
					});
					this.plugin.linkDecorator?.decorateAll();
				})
			);

		new Setting(containerEl)
			.setName("Clicking a typed folder opens its base")
			.setDesc(
				"When the user clicks a folder in the file explorer, open that type's overview base file instead of expanding the folder."
			)
			.addToggle((t) =>
				t
					.setValue(settings.folderClickOpensBase)
					.onChange(async (v) => {
						await this.plugin.manager.updateSettings({
							folderClickOpensBase: v,
						});
					})
			);

		new Setting(containerEl)
			.setName("Parse natural-language dates")
			.setDesc(
				"In the object mention menu, also offer daily notes for queries like \"tomorrow\" or \"next Tuesday\"."
			)
			.addToggle((t) =>
				t
					.setValue(settings.parseNaturalLanguageDates)
					.onChange(async (v) => {
						await this.plugin.manager.updateSettings({
							parseNaturalLanguageDates: v,
						});
					})
			);

		new Setting(containerEl)
			.setName("Register Daily Notes as an object type")
			.setDesc(
				"Mirror the Daily Notes core plugin as a managed object type so typed links and icons work the same as any other type. " +
					"If you change your Daily Notes plugin settings (folder, format, template), disable and re-enable this option to refresh the auto-generated overview."
			)
			.addToggle((t) =>
				t
					.setValue(settings.registerDailyNotes)
					.onChange(async (v) => {
						await this.plugin.manager.updateSettings({
							registerDailyNotes: v,
						});
						await this.plugin.refreshDailyNotesType();
					})
			);

		new Setting(containerEl)
			.setName("Object types")
			.setDesc(
				"Open the Object Type Settings modal to create, edit and repair types."
			)
			.addButton((b) =>
				b
					.setButtonText("Open")
					.setCta()
					.onClick(() => this.plugin.openTypeSettings())
			);
	}
}
