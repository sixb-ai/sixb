import code from "./generated/editor.txt" with { type: "text" }

/**
 * The editor's script, which the app sends a designed document's frame to run, built from
 * `./entry.ts` by `bun run generate:frame-editor`. Imported only when a reader starts editing, so
 * the app loads it then.
 */
export const FRAME_EDITOR_SCRIPT: string = code
