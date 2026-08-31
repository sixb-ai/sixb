import { readFile } from "node:fs/promises"

export interface AgentCliAssets {
  readonly launcher: string
  readonly artifact: Uint8Array
}

let cachedAssets: Promise<AgentCliAssets> | undefined

export function loadAgentCliAssets(): Promise<AgentCliAssets> {
  cachedAssets ??= Promise.all([
    readFile(new URL("./agent-cli/bin/sixb", import.meta.url), "utf8"),
    readFile(new URL("./agent-cli/generated/sixb.mjs", import.meta.url)),
  ]).then(([launcher, artifact]) => ({ launcher, artifact }))
  return cachedAssets
}
