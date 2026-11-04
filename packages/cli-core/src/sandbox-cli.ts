/// <reference path="./sandbox-cli-assets.d.ts" />
import launcher from "./bin/sixb" with { type: "text" }
import bundle from "./generated/sixb.mjs" with { type: "text" }

/** The `sixb` a sandbox installs: a shell launcher and the bundle it runs on Bun or Node. */
export interface SandboxCliAssets {
  readonly launcher: string
  readonly artifact: Uint8Array
}

const assets: SandboxCliAssets = { launcher, artifact: new TextEncoder().encode(bundle) }

/** Part of this module, so that a program compiled to one file carries them too. */
export async function loadSandboxCliAssets(): Promise<SandboxCliAssets> {
  return assets
}
