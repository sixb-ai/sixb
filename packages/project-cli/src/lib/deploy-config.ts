import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { DeployConfig } from "@sixb/core/deploy"
import { validateDeployConfig } from "@sixb/core/internal/deploy"
import { SixbCliError } from "./errors"

export const DEPLOY_CONFIG_FILE = "sixb.deploy.ts"

export interface LoadedDeployConfig {
  readonly path: string
  readonly config: DeployConfig
}

/** Loads `sixb.deploy.ts` from the project directory. */
export async function loadDeployConfig(cwd = process.cwd()): Promise<LoadedDeployConfig> {
  const path = resolve(cwd, DEPLOY_CONFIG_FILE)
  if (!(await Bun.file(path).exists())) {
    throw new SixbCliError(`[SixbDeploy] No ${DEPLOY_CONFIG_FILE} in ${cwd}.`, {
      remediation:
        `Create ${DEPLOY_CONFIG_FILE} in the project directory, exporting ` +
        "`defineDeploy({ ... })` from @sixb/core/deploy as its default.",
    })
  }

  const module = (await import(pathToFileURL(path).href)) as { readonly default?: unknown }
  if (module.default === undefined) {
    throw new SixbCliError(`[SixbDeploy] ${path} has no default export.`, {
      remediation: "Export the deployment: `export default defineDeploy({ ... })`.",
    })
  }
  return { path, config: validateDeployConfig(module.default) }
}
