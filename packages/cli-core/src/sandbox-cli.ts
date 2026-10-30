import { readFile } from "node:fs/promises"

/** The `sixb` a sandbox installs: a shell launcher and the bundle it runs on Bun or Node. */
export interface SandboxCliAssets {
  readonly launcher: string
  readonly artifact: Uint8Array
}

let cachedAssets: Promise<SandboxCliAssets> | undefined

/** Read from beside this module: `src/` in the workspace, `dist/` once built. */
export function loadSandboxCliAssets(): Promise<SandboxCliAssets> {
  cachedAssets ??= Promise.all([
    readFile(new URL("./bin/sixb", import.meta.url), "utf8"),
    readFile(new URL("./generated/sixb.mjs", import.meta.url)),
  ]).then(([launcher, artifact]) => ({ launcher, artifact }))
  return cachedAssets
}
