import { relative } from "node:path"
import { writeJson } from "@sixb/cli-core"
import { loadDeployConfig } from "../lib/deploy-config"
import { buildDeployRelease } from "../lib/deploy-release"
import { SixbCliError } from "../lib/errors"
import { DeployReleaseView, renderStatic } from "../ui"

export interface DeployOptions {
  readonly dryRun?: boolean
  readonly json?: boolean
  readonly cwd?: string
}

export async function runDeploy(options: DeployOptions = {}): Promise<void> {
  const { path, config } = await loadDeployConfig(options.cwd)
  const release = buildDeployRelease(config)

  if (!options.dryRun) {
    throw new SixbCliError("[SixbDeploy] Deploying to a target is not available yet.", {
      remediation: "Run `sixb deploy --dry-run` to print what a deployment runs.",
    })
  }

  if (options.json) {
    writeJson(release)
    return
  }
  await renderStatic(
    <DeployReleaseView release={release} configPath={relative(process.cwd(), path) || path} />
  )
}
