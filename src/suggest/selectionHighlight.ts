import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

export const setSelectionHighlight = StateEffect.define<{
	from: number;
	to: number;
} | null>();

const highlightField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(setSelectionHighlight)) {
				deco =
					effect.value === null
						? Decoration.none
						: Decoration.set([
								Decoration.mark({
									class: "obsidian-objects-sel-highlight",
								}).range(effect.value.from, effect.value.to),
						  ]);
			}
		}
		return deco;
	},
	provide: (f) => EditorView.decorations.from(f),
});

export const selectionHighlightExtension = [highlightField];
