import { App, TFile, editorInfoField, setIcon } from "obsidian";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { Prec, RangeSetBuilder } from "@codemirror/state";
import {
	syntaxTree,
	tokenClassNodeProp,
} from "@codemirror/language";
import { ObjectTypeManager } from "../objectTypeManager";

/**
 * CodeMirror 6 view plugin that prepends the object-type icon to internal
 * links rendered in Live Preview / Source Mode.
 *
 * The previous implementation tried to inject icons by mutating the rendered
 * `contentDOM` after each update. That fights CM6 — it owns those nodes and
 * recreates them aggressively, so injected children disappear quickly. The
 * supported pattern (used by Metadata Menu) is to walk the syntax tree and
 * register `Decoration.widget` decorations at the appropriate offsets. We
 * use the lowest precedence so other plugins' decorations win on conflict.
 *
 * Token shape we look for: nodes carrying the `hmd-internal-link` class via
 * `tokenClassNodeProp`. Those are the link-text inside `[[…]]`, so adding a
 * widget at `node.from` puts the icon immediately to the left of the
 * rendered link text — matching the visual style Metadata Menu users are
 * already familiar with, except positioned before instead of after.
 */
export function buildLinkIconExtension(app: App, manager: ObjectTypeManager) {
	class LinkIconWidget extends WidgetType {
		constructor(private readonly iconName: string) {
			super();
		}
		toDOM(): HTMLElement {
			const span = document.createElement("span");
			span.addClass("obsidian-objects-link-icon");
			span.addClass("obsidian-objects-link-icon--cm");
			span.setAttribute("data-icon", this.iconName);
			span.contentEditable = "false";
			setIcon(span, this.iconName);
			return span;
		}
		eq(other: LinkIconWidget): boolean {
			return other.iconName === this.iconName;
		}
		ignoreEvent(): boolean {
			return true;
		}
	}

	const viewPlugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = this.build(update.view);
				}
			}

			build(view: EditorView): DecorationSet {
				const builder = new RangeSetBuilder<Decoration>();
				if (!manager.getSettings().showLinkIcons) {
					return builder.finish();
				}
				const editorInfo = view.state.field(
					editorInfoField,
					false
				);
				const sourcePath = editorInfo?.file?.path ?? "";

				for (const { from, to } of view.visibleRanges) {
					syntaxTree(view.state).iterate({
						from,
						to,
						enter: (node) => {
							const props = node.type.prop(
								tokenClassNodeProp
							);
							if (!props) return;
							const classes = new Set(props.split(" "));
							const isInternal =
								classes.has("hmd-internal-link");
							const isAlias = classes.has("link-alias");
							const isPipe =
								classes.has("link-alias-pipe");
							if (!isInternal || isAlias || isPipe) {
								return;
							}
							let linkText = view.state.doc.sliceString(
								node.from,
								node.to
							);
							// The link path may include a `#heading` or
							// `#^block` suffix — strip those so we look up
							// the file rather than the anchor.
							linkText = linkText.split(/[#^]/)[0];
							const dest = app.metadataCache.getFirstLinkpathDest(
								linkText,
								sourcePath
							);
							if (!(dest instanceof TFile)) return;
							const type = manager.getTypeForPath(dest.path);
							if (!type?.icon) return;
							builder.add(
								node.from,
								node.from,
								Decoration.widget({
									widget: new LinkIconWidget(type.icon),
									side: -1,
								})
							);
						},
					});
				}
				return builder.finish();
			}
		},
		{
			decorations: (v) => v.decorations,
		}
	);

	// Run at lowest precedence so we don't fight other plugins (folder notes,
	// metadata menu, etc.) that may want to add their own widgets next to
	// the same link.
	return Prec.lowest(viewPlugin);
}
