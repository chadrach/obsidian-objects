import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	TFile,
} from "obsidian";
import { ObjectProperty, ObjectTypeDefinition } from "../types";
import { ObjectTypeManager } from "../objectTypeManager";
import { joinPath, uniquePath } from "../utils";

type MappingAction = "keep" | "delete" | { mapTo: string };

/**
 * "Change object type" modal.
 *
 * Drives `ObjectTypeManager.changeObjectType`. The user gets:
 *   - A from→to summary at the top.
 *   - A row per existing frontmatter key with a dropdown to keep, map to a
 *     specific new-type property, or delete it. Same-named properties are
 *     auto-mapped (kept) by default.
 *   - A list of new-type properties that will be added with their defaults.
 *   - A conflict warning + auto-rename when the destination folder already
 *     contains a file with the same name.
 *   - An explicit warning that the operation rewrites frontmatter and moves
 *     the file before the user can confirm.
 *
 * The modal does not touch disk until the user clicks the apply button — the
 * mapping is built locally and applied atomically by the manager method.
 */
export class ChangeObjectTypeModal extends Modal {
	private mappings = new Map<string, MappingAction>();
	private existingFm: Record<string, unknown> = {};
	private targetPath: string;

	constructor(
		app: App,
		private readonly manager: ObjectTypeManager,
		private readonly file: TFile,
		private readonly newType: ObjectTypeDefinition
	) {
		super(app);
		this.targetPath = joinPath(newType.folderPath, file.name);
	}

	onOpen(): void {
		this.modalEl.addClass("obsidian-objects-modal");
		const cache = this.app.metadataCache.getFileCache(this.file);
		const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		// Strip the synthetic "position" key Obsidian adds to its cached
		// frontmatter — it's metadata about where the YAML block lives, not
		// a real property the user authored.
		for (const [key, value] of Object.entries(fm)) {
			if (key === "position") continue;
			this.existingFm[key] = value;
		}
		this.initializeMappings();
		this.resolveConflict();
		this.render();
	}

	private initializeMappings(): void {
		for (const key of Object.keys(this.existingFm)) {
			this.mappings.set(key, "keep");
		}
	}

	/**
	 * Detect a destination filename conflict and update `targetPath` to the
	 * auto-resolved unique path so the rest of the UI can render the actual
	 * landing path. We never overwrite an unrelated note silently.
	 */
	private resolveConflict(): void {
		if (this.file.path === this.targetPath) return;
		const existing = this.app.vault.getAbstractFileByPath(this.targetPath);
		if (existing instanceof TFile) {
			this.targetPath = uniquePath(
				this.app.vault,
				this.newType.folderPath,
				this.file.basename
			);
		}
	}

	private render(): void {
		this.contentEl.empty();
		const currentType = this.manager.getTypeForPath(this.file.path);
		this.titleEl.setText(`Change to ${this.newType.name}`);

		// --- From → To summary ----------------------------------------
		const summary = this.contentEl.createDiv({
			cls: "obsidian-objects-change-summary",
		});
		const fromLine = summary.createDiv();
		fromLine.createEl("strong", { text: "From: " });
		fromLine.appendText(
			currentType
				? `${this.manager.getQualifiedName(currentType)} — ${this.file.path}`
				: `Untyped — ${this.file.path}`
		);
		const toLine = summary.createDiv();
		toLine.createEl("strong", { text: "To: " });
		toLine.appendText(
			`${this.manager.getQualifiedName(this.newType)} — ${this.targetPath}`
		);

		// --- Conflict banner -----------------------------------------
		// Only fires when our resolveConflict step had to rename the file —
		// the targetPath has already been set to the unique value, so we
		// detect the rename by comparing against the would-be path.
		const wouldBe = joinPath(this.newType.folderPath, this.file.name);
		if (this.targetPath !== wouldBe && this.file.path !== wouldBe) {
			const banner = this.contentEl.createDiv({
				cls: "obsidian-objects-banner",
			});
			banner.createDiv({
				cls: "obsidian-objects-banner__title",
				text: "Filename conflict",
			});
			const detail = banner.createEl("p");
			detail.appendText(
				`A file already exists at "${wouldBe}". The note will be saved as `
			);
			detail.createEl("code", { text: this.targetPath });
			detail.appendText(" instead.");
		}

		// --- Existing properties mapping -----------------------------
		this.contentEl.createEl("h3", { text: "Existing properties" });
		const existingKeys = Object.keys(this.existingFm);
		if (existingKeys.length === 0) {
			this.contentEl.createDiv({
				cls: "obsidian-objects-empty",
				text: "This note has no frontmatter properties.",
			});
		} else {
			const tableEl = this.contentEl.createDiv({
				cls: "obsidian-objects-mapping-table",
			});
			const newProps = this.manager.getEffectiveProperties(this.newType);
			const typeKey = this.manager.getSettings().typePropertyName;
			for (const key of existingKeys) {
				this.renderMappingRow(tableEl, key, newProps, typeKey);
			}
		}

		// --- Properties to add ---------------------------------------
		const newProps = this.manager.getEffectiveProperties(this.newType);
		const mappedTargets = new Set<string>();
		for (const action of this.mappings.values()) {
			if (typeof action === "object" && "mapTo" in action) {
				mappedTargets.add(action.mapTo);
			}
		}
		// "Kept" properties retain the original key, so they implicitly map
		// to themselves only when the existing key equals a new-type prop.
		const kept = new Set<string>();
		for (const [key, action] of this.mappings) {
			if (action === "keep") kept.add(key);
		}
		const willAdd = newProps.filter(
			(p) => !mappedTargets.has(p.name) && !kept.has(p.name)
		);
		if (willAdd.length > 0) {
			this.contentEl.createEl("h3", {
				text: `Properties to add (${willAdd.length})`,
			});
			const list = this.contentEl.createEl("ul", {
				cls: "obsidian-objects-add-list",
			});
			for (const prop of willAdd) {
				const li = list.createEl("li");
				li.createEl("code", { text: prop.name });
				li.appendText(` — ${prop.type}`);
				if (
					prop.defaultValue !== undefined &&
					prop.defaultValue !== null &&
					prop.defaultValue !== ""
				) {
					li.appendText(` (default: ${prop.defaultValue})`);
				}
			}
		}

		// --- Warning + footer ----------------------------------------
		const warn = this.contentEl.createDiv({
			cls: "obsidian-objects-warn",
		});
		warn.createEl("strong", { text: "Heads up: " });
		warn.appendText(
			"this note's frontmatter and location will both change. " +
				"Properties marked Delete will be removed permanently and any " +
				"wikilinks pointing to this note will be updated to the new path."
		);

		const footer = this.contentEl.createDiv({
			cls: "obsidian-objects-modal__footer",
		});
		new ButtonComponent(footer)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		new ButtonComponent(footer)
			.setButtonText(`Change to ${this.newType.name}`)
			.setCta()
			.onClick(() => void this.handleConfirm());
	}

	private renderMappingRow(
		container: HTMLElement,
		key: string,
		newProps: ObjectProperty[],
		typeKey: string
	): void {
		const row = container.createDiv({
			cls: "obsidian-objects-mapping-row",
		});
		const label = row.createDiv({
			cls: "obsidian-objects-mapping-row__label",
		});
		label.createEl("code", { text: key });
		const value = this.existingFm[key];
		label.createDiv({
			cls: "obsidian-objects-mapping-row__value",
			text: previewValue(value),
		});

		// The type-identifier property is stamped automatically by the change
		// operation. Show it as an inert info row so the user understands
		// they don't need to map it.
		if (key === typeKey) {
			row.createDiv({
				cls: "obsidian-objects-mapping-row__status",
				text: `Will be set to "${this.manager.getQualifiedName(this.newType)}"`,
			});
			return;
		}

		const select = row.createEl("select", {
			cls: "obsidian-objects-mapping-row__select",
		});
		select.createEl("option", {
			text: `Keep "${key}"`,
			value: "keep",
		});
		// Offer mapping to every new-type property except the same-name one
		// (mapping a key to itself is just "keep").
		for (const prop of newProps) {
			if (prop.name === key) continue;
			select.createEl("option", {
				text: `Map to "${prop.name}"`,
				value: `map:${prop.name}`,
			});
		}
		select.createEl("option", { text: "Delete", value: "delete" });

		const current = this.mappings.get(key);
		if (current === "delete") {
			select.value = "delete";
		} else if (typeof current === "object" && "mapTo" in current) {
			select.value = `map:${current.mapTo}`;
		} else {
			select.value = "keep";
		}

		select.addEventListener("change", () => {
			const v = select.value;
			if (v === "delete") {
				this.mappings.set(key, "delete");
			} else if (v.startsWith("map:")) {
				this.mappings.set(key, { mapTo: v.slice(4) });
			} else {
				this.mappings.set(key, "keep");
			}
			// Re-render so the "Properties to add" list updates as the user
			// reassigns mappings.
			this.render();
		});
	}

	private async handleConfirm(): Promise<void> {
		const mapping: Record<
			string,
			"keep" | "delete" | { mapTo: string }
		> = {};
		this.mappings.forEach((v, k) => {
			mapping[k] = v;
		});
		try {
			await this.manager.changeObjectType(this.file, this.newType, {
				propertyMapping: mapping,
				targetPath: this.targetPath,
			});
			new Notice(`Changed to ${this.newType.name}`);
			this.close();
		} catch (err) {
			console.error(err);
			new Notice(`Failed to change object type: ${err}`);
		}
	}
}

function previewValue(value: unknown): string {
	if (value === null || value === undefined) return "(empty)";
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const head = value.slice(0, 3).map(String).join(", ");
		return value.length > 3 ? `[${head}, …]` : `[${head}]`;
	}
	if (typeof value === "object") return "{…}";
	const s = String(value);
	return s.length > 60 ? s.slice(0, 57) + "…" : s;
}
