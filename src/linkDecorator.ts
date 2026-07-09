import {
	App,
	MarkdownPostProcessor,
	MarkdownPostProcessorContext,
	MarkdownView,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import { ObjectTypeManager } from "./objectTypeManager";

/**
 * Prepends an icon to every internal link that points to a note belonging to
 * a registered object type. Works in reading mode (via the markdown post
 * processor) and in the file-explorer / navigation panes (via DOM mutation).
 *
 * For the editor itself (live-preview / source mode) we also decorate
 * rendered link nodes after each layout change. We do not ship a CodeMirror 6
 * extension here — doing it purely via DOM covers the common cases without
 * requiring the plugin to depend on CM internals, which change between
 * Obsidian versions.
 */
export class LinkDecorator {
	private observer: MutationObserver | null = null;

	constructor(
		private readonly app: App,
		private readonly manager: ObjectTypeManager
	) {}

	readingModePostProcessor: MarkdownPostProcessor = (
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) => {
		if (!this.manager.getSettings().showLinkIcons) return;
		const links = el.querySelectorAll("a.internal-link");
		links.forEach((anchor) => {
			this.decorateAnchor(anchor as HTMLElement, ctx.sourcePath);
		});
	};

	/**
	 * Watch the workspace for new nodes and apply icons where relevant. We
	 * debounce through `requestAnimationFrame` so bursts of DOM churn (like
	 * opening a folder in the file explorer) coalesce into one pass.
	 */
	observeWorkspace(): void {
		if (this.observer) return;
		let scheduled = false;
		const run = () => {
			scheduled = false;
			this.decorateAll();
		};
		this.observer = new MutationObserver(() => {
			if (scheduled) return;
			scheduled = true;
			window.requestAnimationFrame(run);
		});
		const root = this.app.workspace.containerEl;
		this.observer.observe(root, { childList: true, subtree: true });
	}

	disconnect(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	decorateAll(): void {
		if (!this.manager.getSettings().showLinkIcons) {
			this.app.workspace.containerEl
				.querySelectorAll(".obsidian-objects-link-icon")
				.forEach((n) => n.remove());
			return;
		}
		this.decorateFileExplorer();
		this.decorateRenderedLinks();
		this.decoratePillsAndLinkWrappers();
		this.decorateBasesFileNames();
		this.decorateTabHeaders();
	}

	private decorateFileExplorer(): void {
		const leaves = this.app.workspace.getLeavesOfType("file-explorer");
		for (const leaf of leaves) {
			this.decorateFileExplorerLeaf(leaf);
		}
	}

	private decorateFileExplorerLeaf(leaf: WorkspaceLeaf): void {
		const container = leaf.view.containerEl;
		// Folders
		container
			.querySelectorAll(".nav-folder-title")
			.forEach((el) => {
				const path = (el as HTMLElement).dataset.path;
				if (!path) return;
				const type = this.manager.getTypeByFolder(path);
				this.applyIcon(
					el as HTMLElement,
					type?.icon ?? null,
					"nav-folder"
				);
				// Underline typed folder titles so they're visually distinct.
				if (type) {
					(el as HTMLElement).addClass(
						"obsidian-objects-typed-folder"
					);
				} else {
					(el as HTMLElement).removeClass(
						"obsidian-objects-typed-folder"
					);
				}
			});
		// Files
		container
			.querySelectorAll(".nav-file-title")
			.forEach((el) => {
				const path = (el as HTMLElement).dataset.path;
				if (!path) return;
				const type = this.manager.getTypeForPath(path);
				this.applyIcon(
					el as HTMLElement,
					type?.icon ?? null,
					"nav-file"
				);
			});
	}

	private decorateRenderedLinks(): void {
		const root = this.app.workspace.containerEl;
		// Reading mode, live-preview body, and any other rendered anchor.
		// `a[data-href]` catches Obsidian internal links that don't always
		// carry the `internal-link` class (e.g. Properties editor chips).
		// Bases table/list views render the file.name cell as a <span> with
		// class `internal-link` and `data-href` (not an <a>), so we include
		// the span variant here too.
		root.querySelectorAll(
			"a.internal-link, a[data-href], span.internal-link[data-href]"
		).forEach((el) => {
			this.decorateAnchor(el as HTMLElement, "");
		});
	}

	/**
	 * Bases card view renders the file.name title as a plain <div> with no
	 * path attribute — just display text. We resolve the file by its name via
	 * metadataCache and prepend the type icon to the title line.
	 */
	private decorateBasesFileNames(): void {
		const root = this.app.workspace.containerEl;
		root.querySelectorAll(
			".bases-cards-property.mod-title .bases-cards-line.bases-rendered-value"
		).forEach((el) => {
			const title = el.textContent?.trim();
			if (!title) return;
			const dest = this.app.metadataCache.getFirstLinkpathDest(title, "");
			if (!(dest instanceof TFile)) return;
			const type = this.manager.getTypeForPath(dest.path);
			this.applyIcon(el as HTMLElement, type?.icon ?? null, "link");
		});
	}

	/**
	 * The structured Properties editor renders link values as either
	 * `.metadata-link` wrappers (single link) or `.multi-select-pill` chips
	 * (list/multi-link). Bases tables use the same multi-select pills for
	 * link cells. Neither carries an `a.internal-link`-class anchor, so the
	 * generic anchor pass above misses them. Pills carry the wikilink target
	 * either in `data-value` or as their text; we resolve through metadataCache
	 * so we don't have to know which is which.
	 */
	private decoratePillsAndLinkWrappers(): void {
		const root = this.app.workspace.containerEl;
		root.querySelectorAll(".multi-select-pill").forEach((pill) => {
			this.decoratePill(pill as HTMLElement);
		});
		root.querySelectorAll(
			".metadata-link-inner, .metadata-link a"
		).forEach((el) => {
			this.decorateAnchor(el as HTMLElement, "");
		});
	}

	private decoratePill(pill: HTMLElement): void {
		const value =
			pill.getAttribute("data-value") ??
			pill
				.querySelector(".multi-select-pill-content")
				?.textContent?.trim() ??
			pill.textContent?.trim();
		if (!value) return;
		const dest = this.app.metadataCache.getFirstLinkpathDest(value, "");
		if (!(dest instanceof TFile)) return;
		const type = this.manager.getTypeForPath(dest.path);
		this.applyIcon(pill, type?.icon ?? null, "link");
	}

	/**
	 * Prepend the object-type icon to the workspace tab header for every open
	 * markdown file that belongs to a registered type.
	 */
	private decorateTabHeaders(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const file = view.file;
			if (!file) continue;
			const type = this.manager.getTypeForPath(file.path);
			const tabHeaderEl = (
				leaf as unknown as { tabHeaderEl?: HTMLElement }
			).tabHeaderEl;
			if (!tabHeaderEl) continue;
			const titleEl = tabHeaderEl.querySelector(
				".workspace-tab-header-inner-title"
			) as HTMLElement | null;
			if (!titleEl) continue;
			this.applyIcon(titleEl, type?.icon ?? null, "tab");
		}
	}

	private decorateAnchor(el: HTMLElement, sourcePath: string): void {
		const href = el.getAttribute("data-href") ?? el.getAttribute("href");
		if (!href) return;
		// metadataCache.getFirstLinkpathDest expects wikilink-style paths
		// (no extension). Bases table cells set data-href to the full vault
		// path including ".md", so fall back to a direct vault lookup when
		// the metadata cache returns nothing.
		let dest = this.app.metadataCache.getFirstLinkpathDest(href, sourcePath);
		if (!(dest instanceof TFile)) {
			const byPath = this.app.vault.getAbstractFileByPath(href);
			if (byPath instanceof TFile) dest = byPath;
		}
		if (!(dest instanceof TFile)) return;
		const type = this.manager.getTypeForPath(dest.path);
		this.applyIcon(el, type?.icon ?? null, "link");
	}

	private applyIcon(
		host: HTMLElement,
		iconName: string | null,
		variant: "link" | "nav-file" | "nav-folder" | "tab"
	): void {
		const existing = host.querySelector(".obsidian-objects-link-icon");
		if (!iconName) {
			existing?.remove();
			return;
		}
		if (existing) {
			if (existing.getAttribute("data-icon") === iconName) return;
			existing.remove();
		}
		const span = document.createElement("span");
		span.addClass("obsidian-objects-link-icon");
		span.addClass(`obsidian-objects-link-icon--${variant}`);
		span.setAttribute("data-icon", iconName);
		setIcon(span, iconName);
		// Folder rows show the icon trailing the folder name; everything else
		// reads more naturally with the icon ahead of the label.
		if (variant === "nav-folder") {
			host.appendChild(span);
		} else {
			host.prepend(span);
		}
	}
}
