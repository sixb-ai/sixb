import { join } from "node:path"
import { writeJson } from "@sixb/cli-core"
import type { DeployConfig } from "@sixb/core/deploy"
import { DEPLOY_CONFIG_FILE, loadDeployConfig } from "../lib/deploy-config"
import { deployPublicOrigins } from "../lib/deploy-release"
import {
  DESKTOP_INSTALLERS,
  DESKTOP_PLATFORM_NAMES,
  DESKTOP_RELEASE_PLATFORMS,
  DESKTOP_RUNNER_ENTRY,
  type DesktopReleasePlatform,
  desktopReleaseUrl,
  loadDesktop,
  releasedDesktopVersion,
} from "../lib/desktop"
import { SixbCliError } from "../lib/errors"
import { configuredOrigin } from "../lib/public-origin"
import { keyValueResultView, renderStatic, tableResultView, withTask } from "../ui"

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
    runnerEntry: DESKTOP_RUNNER_ENTRY,
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

/** The deployment a release goes to, and where it serves the app and the API. */
interface ReleaseTarget {
  readonly config: DeployConfig
  readonly app: string
  readonly api: string
}

/**
 * Only the deployment says where a release goes: an origin from `.env` or a flag, often the local
 * app's, would be built into every installed copy.
 */
async function releaseTarget(projectRoot: string): Promise<ReleaseTarget> {
  const { config } = await loadDeployConfig(projectRoot)
  const origins = deployPublicOrigins(config)
  if (!origins.app || !origins.api) {
    throw new SixbCliError(
      "[SixbCLI] The desktop app opens the deployed app, which is turned off.",
      {
        remediation: `Turn on the app and api services in ${DEPLOY_CONFIG_FILE}.`,
      }
    )
  }
  return { config, app: origins.app, api: origins.api }
}

/** The version people get, from the project's `package.json`, which a release must raise. */
async function projectVersion(projectRoot: string): Promise<string> {
  const manifest = (await Bun.file(join(projectRoot, "package.json"))
    .json()
    .catch(() => null)) as { readonly version?: unknown } | null
  const version = manifest?.version
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new SixbCliError("[SixbCLI] A desktop release takes its version from package.json.", {
      remediation: 'Set "version" in package.json, such as "1.0.0".',
    })
  }
  return version
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function thisPlatform(): DesktopReleasePlatform {
  const platform = DESKTOP_RELEASE_PLATFORMS.find((name) => name === process.platform)
  if (!platform) {
    throw new SixbCliError("[SixbCLI] Desktop releases are made on macOS for now.")
  }
  return platform
}

export interface DesktopReleaseOptions {
  readonly json?: boolean
  readonly cwd?: string
}

/**
 * Builds, signs and publishes the desktop app for this machine's system, unless the deployment
 * already serves this version. Runs unattended, as in CI, and never publishes an unsigned build.
 */
export async function runDesktopRelease(options: DesktopReleaseOptions = {}): Promise<void> {
  const projectRoot = options.cwd ?? process.cwd()
  const platform = thisPlatform()
  const target = await releaseTarget(projectRoot)
  const publish = target.config.target.publishDesktop?.bind(target.config.target)
  if (!publish) {
    throw new SixbCliError(
      `[SixbCLI] A ${target.config.target.kind} target cannot publish a desktop app.`
    )
  }
  const version = await projectVersion(projectRoot)
  const system = DESKTOP_PLATFORM_NAMES[platform]
  const download = desktopReleaseUrl(target.app, platform, DESKTOP_INSTALLERS[platform])

  const released = await releasedDesktopVersion(target.app, platform)
  if (!needsRelease(released, version, system)) {
    if (options.json) return writeJson({ platform, version, released: false, download })
    return renderStatic(
      keyValueResultView({
        title: `${version} is already released for ${system}`,
        items: [{ label: "Download", value: download }],
        message: "Raise version in package.json to release again.",
      })
    )
  }

  const desktop = await loadDesktop(projectRoot)
  const built = await desktop.buildDesktopApp({
    projectRoot,
    appUrl: target.app,
    apiOrigin: target.api,
    runnerEntry: DESKTOP_RUNNER_ENTRY,
    requireSignature: true,
  })
  if (!built.release || !built.signed) {
    throw new SixbCliError("[SixbCLI] This @sixb/desktop builds no release.", {
      remediation: "Run `bun add -d @sixb/desktop@latest`, then try again.",
    })
  }
  const release = built.release
  await withTask("desktop release", `Publishing to ${new URL(target.app).host}`, () =>
    publish(release, { name: target.config.name })
  )

  if (options.json) return writeJson({ platform, version, released: true, download })
  await renderStatic(
    keyValueResultView({
      title: `Released ${version} for ${system}`,
      items: [{ label: "Download", value: download }],
    })
  )
}

/**
 * Whether `version` is new to the deployment. The same version is released already, which isn't a
 * failure, so CI can run a release on every commit; an older one is.
 */
export function needsRelease(released: string | null, version: string, system: string): boolean {
  if (released === null) return true
  const order = Bun.semver.order(released, version)
  if (order > 0) {
    throw new SixbCliError(
      `[SixbCLI] The ${system} release is ${released}, newer than ${version} in package.json.`,
      { remediation: `Raise version in package.json above ${released}.` }
    )
  }
  return order < 0
}

export interface DesktopStatusOptions {
  readonly json?: boolean
  readonly cwd?: string
}

/** What the deployment serves of the desktop app, beside the version `package.json` names. */
export async function runDesktopStatus(options: DesktopStatusOptions = {}): Promise<void> {
  const projectRoot = options.cwd ?? process.cwd()
  const target = await releaseTarget(projectRoot)
  const version = await projectVersion(projectRoot)
  const platforms = await Promise.all(
    DESKTOP_RELEASE_PLATFORMS.map(async (platform) => {
      const released = await releasedDesktopVersion(target.app, platform)
      return {
        platform,
        released,
        // What a release from here would publish: CI releases only these.
        outdated: released === null || Bun.semver.order(released, version) < 0,
      }
    })
  )

  if (options.json) return writeJson({ version, platforms })
  await renderStatic(
    tableResultView({
      subtitle: new URL(target.app).host,
      headers: ["", "Released", "package.json"],
      rows: platforms.map(({ platform, released }) => [
        DESKTOP_PLATFORM_NAMES[platform],
        released ?? "—",
        version,
      ]),
      emptyMessage: "",
    })
  )
}
