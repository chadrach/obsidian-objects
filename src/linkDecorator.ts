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
			this.decorateAnchor(anchor as HTMLAnchorElement, ctx.sourcePath);
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
		root.querySelectorAll("a.internal-link, a[data-href]").forEach(
			(anchor) => {
				this.decorateAnchor(anchor as HTMLAnchorElement, "");
			}
		);
		// Properties editor values can render as anchors inside
		// .metadata-property-value or .metadata-content.
		root.querySelectorAll(
			".metadata-property-value a, .metadata-content a"
		).forEach((anchor) => {
			this.decorateAnchor(anchor as HTMLAnchorElement, "");
		});
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

	private decorateAnchor(
		anchor: HTMLAnchorElement,
		sourcePath: string
	): void {
		const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
		if (!href) return;
		const dest = this.app.metadataCache.getFirstLinkpathDest(
			href,
			sourcePath
		);
		if (!(dest instanceof TFile)) return;
		const type = this.manager.getTypeForPath(dest.path);
		this.applyIcon(anchor, type?.icon ?? null, "link");
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
		host.prepend(span);
	}
}
