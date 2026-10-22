import { join } from "node:path"
import { DEPLOY_CONFIG_FILE, loadDeployConfig } from "../lib/deploy-config"
import { deployPublicOrigins } from "../lib/deploy-release"
import { loadDesktop } from "../lib/desktop"
import { SixbCliError } from "../lib/errors"
import { configuredOrigin } from "../lib/public-origin"
import { keyValueResultView, renderStatic } from "../ui"

export interface DesktopBuildOptions {
  readonly apiPublicOrigin?: string
  readonly appPublicOrigin?: string
}

/** Packages the deployed app as a desktop app for this machine. */
export async function runDesktopBuild(options: DesktopBuildOptions = {}): Promise<void> {
  const projectRoot = process.cwd()
  const desktop = await loadDesktop(projectRoot)
  const origins = await deployedOrigins(projectRoot, options)
  const built = await desktop.buildDesktopApp({
    projectRoot,
    appUrl: origins.app,
    apiOrigin: origins.api,
  })

  await renderStatic(
    keyValueResultView({
      title: "Built the desktop app",
      items: [
        { label: "Opens", value: origins.app },
        { label: "Output", value: built.path },
      ],
      message: built.signed
        ? undefined
        : "Unsigned: people who download it are warned before it opens. See @sixb/desktop's README to sign it.",
    })
  )
}

/**
 * Where the desktop app connects, found the way the production roles find their public origins:
 * flags, then `SIXB_APP_PUBLIC_ORIGIN` and `SIXB_API_PUBLIC_ORIGIN`, then the deployment.
 */
export async function deployedOrigins(
  projectRoot: string,
  options: DesktopBuildOptions
): Promise<{ readonly app: string; readonly api: string }> {
  const app = configuredOrigin(
    options.appPublicOrigin,
    "SIXB_APP_PUBLIC_ORIGIN",
    "app public origin"
  )
  const api = configuredOrigin(
    options.apiPublicOrigin,
    "SIXB_API_PUBLIC_ORIGIN",
    "API public origin"
  )
  const deployed =
    (!app || !api) && (await Bun.file(join(projectRoot, DEPLOY_CONFIG_FILE)).exists())
      ? deployPublicOrigins((await loadDeployConfig(projectRoot)).config)
      : {}

  const origins = { app: app ?? deployed.app, api: api ?? deployed.api }
  if (!origins.app || !origins.api) {
    throw new SixbCliError("[SixbCLI] The desktop app needs to know where the app is deployed.", {
      remediation:
        `Describe the deployment in ${DEPLOY_CONFIG_FILE}, or set SIXB_APP_PUBLIC_ORIGIN and ` +
        "SIXB_API_PUBLIC_ORIGIN.",
    })
  }
  return { app: origins.app, api: origins.api }
}
