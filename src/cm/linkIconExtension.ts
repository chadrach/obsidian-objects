import { App, TFile, setIcon } from "obsidian";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { ObjectTypeManager } from "../objectTypeManager";

/**
 * CodeMirror 6 view plugin that prepends an object-type icon to internal
 * links rendered in Live Preview / Source Mode.
 *
 * The reading-mode post-processor handles regular preview rendering, but
 * Live Preview decorates links inside the CM6 contentDOM as anchors with
 * the `internal-link` class — those don't go through the post-processor.
 * Rather than build a full `Decoration` tree (which would mean replacing
 * Obsidian's own widgets, risking visual regressions), we walk the rendered
 * DOM after each view update and inject a small icon span at the start of
 * each link. CM6 recreates these nodes whenever the viewport changes, so we
 * must re-apply on every update.
 */
export function buildLinkIconExtension(
	app: App,
	manager: ObjectTypeManager,
	getSourcePath: (view: EditorView) => string | null
) {
	return ViewPlugin.fromClass(
		class {
			private scheduled = 0;
			constructor(private readonly view: EditorView) {
				this.schedule();
			}
			update(update: ViewUpdate) {
				if (
					update.docChanged ||
					update.viewportChanged ||
					update.geometryChanged
				) {
					this.schedule();
				}
			}
			destroy() {
				if (this.scheduled) cancelAnimationFrame(this.scheduled);
				clearIcons(this.view.contentDOM);
			}
			/**
			 * Mutating contentDOM from inside `update()` confuses CM6's
			 * own bookkeeping. Defer to the next animation frame so we run
			 * after CM6 has finished applying its decoration pass.
			 */
			private schedule() {
				if (this.scheduled) return;
				this.scheduled = requestAnimationFrame(() => {
					this.scheduled = 0;
					this.decorate();
				});
			}
			private decorate() {
				if (!manager.getSettings().showLinkIcons) {
					clearIcons(this.view.contentDOM);
					return;
				}
				const sourcePath = getSourcePath(this.view) ?? "";
				const links = this.view.contentDOM.querySelectorAll(
					"a.internal-link"
				);
				links.forEach((node) => {
					applyIconToAnchor(
						app,
						manager,
						node as HTMLAnchorElement,
						sourcePath
					);
				});
			}
		}
	);
}

function applyIconToAnchor(
	app: App,
	manager: ObjectTypeManager,
	anchor: HTMLAnchorElement,
	sourcePath: string
): void {
	const href =
		anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
	if (!href) return;
	const dest = app.metadataCache.getFirstLinkpathDest(href, sourcePath);
	const type =
		dest instanceof TFile ? manager.getTypeForPath(dest.path) : null;
	const iconName = type?.icon ?? null;
	const existing = anchor.querySelector(".obsidian-objects-link-icon");
	if (!iconName) {
		existing?.remove();
		return;
	}
	if (
		existing &&
		existing.getAttribute("data-icon") === iconName
	) {
		return;
	}
	existing?.remove();
	const span = document.createElement("span");
	span.addClass("obsidian-objects-link-icon");
	span.addClass("obsidian-objects-link-icon--cm");
	span.setAttribute("data-icon", iconName);
	span.contentEditable = "false";
	setIcon(span, iconName);
	anchor.prepend(span);
}

function clearIcons(root: HTMLElement): void {
	root
		.querySelectorAll(".obsidian-objects-link-icon")
		.forEach((n) => n.remove());
}
