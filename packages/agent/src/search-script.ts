/// <reference path="./search-script-assets.d.ts" />
import script from "./generated/search.mjs" with { type: "text" }

/**
 * The engine of `glob` and `grep`, bundled from `tools/search/` by
 * `bun run generate:search-script`. A run installs it at `lib/search.mjs` and runs it on Bun or
 * Node. Part of this module, so that a program compiled to one file carries it too.
 */
export const SEARCH_SCRIPT_SOURCE: Uint8Array = new TextEncoder().encode(script)
