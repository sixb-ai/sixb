import { pathToFileURL } from "node:url"
import { SixbCliError } from "./errors"

export interface DesktopAppOptions {
  readonly projectRoot: string
  /** Where the app is served. The desktop app opens it and takes its name and icon from it. */
  readonly appUrl: string
  readonly apiOrigin: string
}

/**
 * What the CLI calls on `@sixb/desktop`. Declared here, not imported: the CLI does not depend on
 * the package, and `desktop.test.ts` holds the two together.
 */
export interface SixbDesktop {
  openDesktopApp(options: DesktopAppOptions): Promise<{
    readonly exited: Promise<number>
    close(): void
  }>
  buildDesktopApp(options: DesktopAppOptions): Promise<{
    readonly path: string
    readonly signed: boolean
  }>
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
