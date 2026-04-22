import {
	App,
	MarkdownPostProcessor,
	MarkdownPostProcessorContext,
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
		const links = this.app.workspace.containerEl.querySelectorAll(
			"a.internal-link"
		);
		links.forEach((anchor) => {
			this.decorateAnchor(anchor as HTMLAnchorElement, "");
		});
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
		variant: "link" | "nav-file" | "nav-folder"
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
