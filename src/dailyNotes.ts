import { App } from "obsidian";
import { ObjectTypeManager } from "./objectTypeManager";
import { ObjectTypeDefinition } from "./types";

interface DailyNotesOptions {
	format?: string;
	folder?: string;
	template?: string;
}

interface InternalPluginHandle {
	enabled: boolean;
	instance?: { options?: DailyNotesOptions };
}

/**
 * Ensure a managed object type mirrors the user's Daily Notes settings.
 * Called on plugin load and whenever the internal Daily Notes plugin changes
 * its configuration. Does nothing if the user has disabled the integration.
 */
export async function syncDailyNotesType(
	app: App,
	manager: ObjectTypeManager
): Promise<void> {
	if (!manager.getSettings().registerDailyNotes) {
		await removeManagedDailyNotesType(manager);
		return;
	}

	const plugin = getDailyNotesPlugin(app);
	if (!plugin || !plugin.enabled) {
		await removeManagedDailyNotesType(manager);
		return;
	}

	const options = plugin.instance?.options ?? {};
	const folder = options.folder?.trim() || "Daily Notes";

	const existing = manager
		.getTypes()
		.find((t) => t.managed === "daily-notes");

	if (existing) {
		if (existing.folderPath !== folder) {
			await manager.updateType(existing.id, {
				properties: existing.properties,
			});
			// Folder moves aren't something we can fix automatically without
			// risking stepping on user edits. The settings modal will surface
			// this as a broken reference and let the user repair it.
		}
		return;
	}

	await manager.createType({
		name: "Daily Note",
		pluralName: "Daily Notes",
		icon: "calendar",
		folderPath: folder,
		managed: "daily-notes",
		properties: [],
	});
}

function getDailyNotesPlugin(app: App): InternalPluginHandle | null {
	const internal = (app as unknown as {
		internalPlugins?: {
			getPluginById?: (id: string) => InternalPluginHandle | null;
		};
	}).internalPlugins;
	return internal?.getPluginById?.("daily-notes") ?? null;
}

async function removeManagedDailyNotesType(
	manager: ObjectTypeManager
): Promise<void> {
	const existing = manager
		.getTypes()
		.find((t: ObjectTypeDefinition) => t.managed === "daily-notes");
	if (!existing) return;
	// Delete the auto-generated .base file too so a subsequent toggle-on
	// regenerates it from scratch — the user-facing way to refresh the
	// default Daily Notes view template.
	await manager.deleteType(existing.id, { deleteBaseFile: true });
}
