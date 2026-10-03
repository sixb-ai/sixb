import type { DeployConfig } from "./types"

/** Declares a deployment in `sixb.deploy.ts`. `sixb deploy` validates it when it loads the file. */
export function defineDeploy<const TConfig extends DeployConfig>(config: TConfig): TConfig {
  return config
}
