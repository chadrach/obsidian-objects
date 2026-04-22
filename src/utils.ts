import { TFile, TFolder, Vault, normalizePath } from "obsidian";

/** Normalize a user-supplied folder name into a safe vault path. */
export function safeFolderName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Join two vault path segments, stripping stray slashes. */
export function joinPath(a: string, b: string): string {
	const left = a.replace(/\/+$/, "");
	const right = b.replace(/^\/+/, "");
	if (!left) return normalizePath(right);
	return normalizePath(`${left}/${right}`);
}

/** Ensure every folder on a path exists. Idempotent. */
export async function ensureFolder(
	vault: Vault,
	folderPath: string
): Promise<TFolder> {
	const path = normalizePath(folderPath);
	const existing = vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return existing;
	if (existing) {
		throw new Error(
			`Cannot create folder at ${path}: a file already exists there.`
		);
	}
	await vault.createFolder(path);
	const created = vault.getAbstractFileByPath(path);
	if (!(created instanceof TFolder)) {
		throw new Error(`Failed to create folder at ${path}`);
	}
	return created;
}

/** Return every markdown file inside the folder (recursive). */
export function filesInFolder(vault: Vault, folderPath: string): TFile[] {
	const folder = vault.getAbstractFileByPath(normalizePath(folderPath));
	if (!(folder instanceof TFolder)) return [];
	const out: TFile[] = [];
	const walk = (f: TFolder) => {
		for (const child of f.children) {
			if (child instanceof TFile && child.extension === "md") {
				out.push(child);
			} else if (child instanceof TFolder) {
				walk(child);
			}
		}
	};
	walk(folder);
	return out;
}

/** True if `child` is equal to or nested under `parent` (paths, not objects). */
export function isUnder(childPath: string, parentPath: string): boolean {
	const c = normalizePath(childPath);
	const p = normalizePath(parentPath);
	return c === p || c.startsWith(p + "/");
}

export function filenameWithoutExtension(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return dot < 0 ? fileName : fileName.slice(0, dot);
}

/**
 * Minimal YAML frontmatter stringifier. Supports strings, numbers, booleans
 * and arrays of strings — everything a property editor can produce.
 */
export function stringifyFrontmatter(obj: Record<string, unknown>): string {
	const lines: string[] = ["---"];
	for (const [key, value] of Object.entries(obj)) {
		lines.push(formatYamlEntry(key, value));
	}
	lines.push("---", "");
	return lines.join("\n");
}

function formatYamlEntry(key: string, value: unknown): string {
	if (value === null || value === undefined) return `${key}: `;
	if (Array.isArray(value)) {
		if (value.length === 0) return `${key}: []`;
		return (
			`${key}:\n` +
			value.map((v) => `  - ${formatYamlScalar(v)}`).join("\n")
		);
	}
	return `${key}: ${formatYamlScalar(value)}`;
}

function formatYamlScalar(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean" || typeof value === "number") {
		return String(value);
	}
	const s = String(value);
	if (s === "" || /[:#\-&*!|>'"%@`{}\[\],]/.test(s) || /^\s|\s$/.test(s)) {
		return JSON.stringify(s);
	}
	return s;
}

/**
 * Create a unique file path by appending " (2)", " (3)", … if the target
 * already exists. Returns the resolved path (without extension change).
 */
export function uniquePath(
	vault: Vault,
	folderPath: string,
	desiredName: string,
	extension = "md"
): string {
	const base = safeFolderName(desiredName) || "Untitled";
	let attempt = joinPath(folderPath, `${base}.${extension}`);
	let counter = 2;
	while (vault.getAbstractFileByPath(attempt)) {
		attempt = joinPath(folderPath, `${base} (${counter}).${extension}`);
		counter += 1;
	}
	return attempt;
}
