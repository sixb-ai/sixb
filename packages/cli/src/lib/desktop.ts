import { fileURLToPath, pathToFileURL } from "node:url"
import { errorMessage, SixbCliError } from "./errors"

export interface DesktopAppOptions {
  readonly projectRoot: string
  /** Where the app is served. The desktop app opens it and takes its name and icon from it. */
  readonly appUrl: string
  readonly apiOrigin: string
  /** What the app compiles to run the agent on this computer. */
  readonly runnerEntry: string
}

/** From the CLI's `src`, which ships: `@sixb/desktop` compiles it into the app. */
export const DESKTOP_RUNNER_ENTRY = fileURLToPath(
  new URL("../runner/desktop-runner-main.ts", import.meta.url)
)

/**
 * What the CLI calls on `@sixb/desktop`. Declared here, not imported: the CLI does not depend on
 * the package, and `desktop.test.ts` holds the two together.
 */
export interface SixbDesktop {
  openDesktopApp(options: DesktopAppOptions): Promise<{
    readonly exited: Promise<number>
    close(): void
  }>
  buildDesktopApp(options: DesktopAppOptions & { readonly requireSignature?: boolean }): Promise<{
    readonly path: string
    readonly signed: boolean
    /** Absent from a package older than releases. */
    readonly release?: DesktopReleaseFiles | null
  }>
}

/** What `sixb desktop release` publishes: one system's files, served as they are. */
export interface DesktopReleaseFiles {
  readonly platform: DesktopReleasePlatform
  readonly version: string
  readonly dir: string
}

/** The systems desktop releases are made for, in the order `sixb desktop status` lists them. */
export const DESKTOP_RELEASE_PLATFORMS = ["darwin"] as const

export type DesktopReleasePlatform = (typeof DESKTOP_RELEASE_PLATFORMS)[number]

/** How each system is named to people. */
export const DESKTOP_PLATFORM_NAMES: Readonly<Record<DesktopReleasePlatform, string>> = {
  darwin: "macOS",
}

/** Where the deployment serves each system's release, on the app's origin. */
export function desktopReleaseUrl(
  appUrl: string,
  platform: DesktopReleasePlatform,
  file: string
): string {
  return new URL(`/__sixb/desktop/${platform}/${file}`, appUrl).href
}

/** What people download, by system. */
export const DESKTOP_INSTALLERS: Readonly<Record<DesktopReleasePlatform, string>> = {
  darwin: "install.dmg",
}

/**
 * The version a deployment serves for one system, from the feed its installed apps update from.
 * Null when it serves none.
 */
export async function releasedDesktopVersion(
  appUrl: string,
  platform: DesktopReleasePlatform
): Promise<string | null> {
  const url = desktopReleaseUrl(appUrl, platform, "releases.json")
  let response: Response
  try {
    response = await fetch(url, { headers: { "cache-control": "no-cache" } })
  } catch (error) {
    throw new SixbCliError(`[SixbCLI] Could not reach ${url}: ${errorMessage(error)}`)
  }
  if (response.status === 404) return null
  if (!response.ok) throw new SixbCliError(`[SixbCLI] ${url} answered ${response.status}.`)
  const feed = (await response.json().catch(() => null)) as { readonly currentRelease?: unknown }
  if (typeof feed?.currentRelease !== "string") {
    throw new SixbCliError(`[SixbCLI] ${url} names no release.`)
  }
  return feed.currentRelease
}

/**
 * Loads the project's `@sixb/desktop`. The CLI does not depend on it because it brings Electron,
 * which only a project that ships a desktop app should download.
 */
export async function loadDesktop(projectRoot: string): Promise<SixbDesktop> {
  let path: string
  try {
    path = Bun.resolveSync("@sixb/desktop", projectRoot)
  } catch {
    throw new SixbCliError("[SixbCLI] Desktop apps need @sixb/desktop, which this project lacks.", {
      remediation: "Run `bun add -d @sixb/desktop`, then try again.",
    })
  }
  const loaded: unknown = await import(pathToFileURL(path).href)
  if (!isSixbDesktop(loaded)) {
    throw new SixbCliError(`[SixbCLI] The @sixb/desktop at ${path} is not one this CLI can use.`, {
      remediation: "Run `bun add -d @sixb/desktop@latest`, then try again.",
    })
  }
  return loaded
}

function isSixbDesktop(value: unknown): value is SixbDesktop {
  if (typeof value !== "object" || value === null) return false
  const { openDesktopApp, buildDesktopApp } = value as Record<string, unknown>
  return typeof openDesktopApp === "function" && typeof buildDesktopApp === "function"
}
