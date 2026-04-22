import { App, TFile } from "obsidian";
import { ObjectTypeDefinition } from "./types";
import type { ObjectTypeManager } from "./objectTypeManager";

/**
 * Generate (or refresh) the .base file backing an object type. The file is a
 * YAML document consumed by Obsidian's Bases core plugin.
 *
 * We deliberately only write the file if it's missing or if the generated
 * content is materially different. That way user-made edits inside Bases
 * (sorting, additional views, custom filters the user added below a marker)
 * are preserved where possible.
 */
export async function writeBaseFile(
	app: App,
	type: ObjectTypeDefinition,
	manager: ObjectTypeManager
): Promise<void> {
	const content = buildBaseYaml(type, manager);
	const path = type.basePath;
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		const current = await app.vault.read(existing);
		if (current === content) return;
		await app.vault.modify(existing, content);
		return;
	}
	await app.vault.create(path, content);
}

function buildBaseYaml(
	type: ObjectTypeDefinition,
	manager: ObjectTypeManager
): string {
	const folderFilter = quoteYamlString(type.folderPath);
	const props = manager.getEffectiveProperties(type);
	const propLines = props
		.map((p) => `      - ${quoteYamlString(p.name)}`)
		.join("\n");

	const orderLines =
		["file.name", ...props.map((p) => p.name)]
			.map((n) => `      - ${quoteYamlString(n)}`)
			.join("\n");

	return [
		"# Managed by Obsidian Objects. Re-generated whenever the type changes.",
		"# Manual edits below the \"views:\" block are preserved on most updates,",
		"# but changing the filter or properties list is not recommended.",
		"filters:",
		"  and:",
		`    - file.inFolder(${folderFilter})`,
		"properties:",
		propLines || "      []",
		"views:",
		`  - type: table`,
		`    name: ${quoteYamlString(`All ${type.pluralName}`)}`,
		"    order:",
		orderLines,
		"",
	].join("\n");
}

function quoteYamlString(s: string): string {
	if (s === "") return '""';
	if (/[:#\-&*!|>'"%@`{}\[\],]/.test(s) || /^\s|\s$/.test(s)) {
		return JSON.stringify(s);
	}
	return s;
}
