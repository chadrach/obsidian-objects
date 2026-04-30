/**
 * Ambient declarations for CodeMirror extras Obsidian bundles but `@codemirror`
 * npm packages don't expose. We rely on the runtime-bundled CM Obsidian ships
 * (these modules are listed as `external` in esbuild config, so the runtime
 * import resolves against Obsidian's CM, not the npm types).
 */
import type { NodeProp } from "@lezer/common";

declare module "@codemirror/language" {
	export const tokenClassNodeProp: NodeProp<string>;
}
