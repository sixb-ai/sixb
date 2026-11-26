/// <reference path="./cli-assets-module.d.ts" />
import launcherText from "./bin/sixb" with { type: "text" }
import artifactText from "./generated/sixb.mjs" with { type: "text" }

/** The standalone `sixb` CLI launcher and bundle installed in sandboxes and run by users. */
export interface CliAssets {
  readonly launcher: string
  readonly artifact: string
}

const assets: CliAssets = {
  launcher: launcherText,
  artifact: artifactText,
}

export async function loadCliAssets(): Promise<CliAssets> {
  return assets
}
