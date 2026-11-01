import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readAppIdentity } from "./identity"
import { drawMacIcon } from "./mac-icon"
import { run } from "./run"
import type { ShellConfig } from "./shell/navigation"

export interface DesktopAppOptions {
  /** The Sixb project. The desktop app is generated under its `.sixb/desktop`. */
  readonly projectRoot: string
  /** Where the app is served. The window opens it; the desktop app takes its name and icon from it. */
  readonly appUrl: string
  /** The project's API. Its sign-in pages are where the window is approved. */
  readonly apiOrigin: string
}

/** The Electron app `writeDesktopApp` generated, and what it is called. */
export interface GeneratedApp {
  readonly dir: string
  readonly name: string
  readonly version: string
  /** The app's icon in `dir`, when it declares one. */
  readonly icon: string | null
}

// Read from the package's `src`, which ships, whether this module runs from `src` or `dist`.
const SHELL_SOURCE_DIR = fileURLToPath(new URL("../src/shell", import.meta.url))

/** Where a project's desktop app is generated (`app`) and packaged (`dist`). */
export function desktopDir(projectRoot: string, part: "app" | "dist"): string {
  return join(projectRoot, ".sixb", "desktop", part)
}

/**
 * Writes the Electron app that opens `appUrl` into the project's `.sixb/desktop/app`. The directory
 * is build-owned, like the rest of `.sixb`: it is cleared on every call.
 */
export async function writeDesktopApp(options: DesktopAppOptions): Promise<GeneratedApp> {
  const identity = await readAppIdentity(options.appUrl)
  const version = await readProjectVersion(options.projectRoot)
  const dir = desktopDir(options.projectRoot, "app")
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const config: ShellConfig = {
    name: identity.name,
    appUrl: new URL(options.appUrl).href,
    apiOrigin: new URL(options.apiOrigin).origin,
  }
  const manifest = {
    name: "sixb-desktop-app",
    // Names the folder the window's cookies are kept in, so each app has its own sign-in.
    productName: identity.name,
    version,
    private: true,
    main: "main.js",
  }
  const icon = identity.icon ? await writeIcon(dir, identity.icon) : null
  const template = await readFile(join(SHELL_SOURCE_DIR, "index.html"), "utf-8")
  await Promise.all([
    writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(dir, "shell.json"), `${JSON.stringify(config, null, 2)}\n`),
    writeFile(join(dir, "index.html"), renderShellPage(template, { ...config, icon: !!icon })),
  ])

  // Electron loads plain JavaScript. A child process, because an in-process `Bun.build()` that
  // wedges takes its caller down with it.
  await run(
    [
      process.execPath,
      "build",
      join(SHELL_SOURCE_DIR, "main.ts"),
      join(SHELL_SOURCE_DIR, "preload.ts"),
      "--target=node",
      "--format=cjs",
      "--external=electron",
      `--outdir=${dir}`,
    ],
    "Could not compile the desktop shell."
  )
  return { dir, name: identity.name, version, icon }
}

/** The page the window shows while the app loads, and when it cannot reach the app. */
export function renderShellPage(
  template: string,
  page: { readonly name: string; readonly appUrl: string; readonly icon: boolean }
): string {
  const initial = Array.from(page.name.trim())[0]?.toUpperCase() ?? ""
  const markup: Record<string, string> = {
    name: escapeHtml(page.name),
    host: escapeHtml(new URL(page.appUrl).host),
    appUrl: escapeHtml(page.appUrl),
    // The app's icon, or the first letter of its name standing in for one.
    mark: page.icon
      ? '<img class="mark" src="icon.png" alt="" />'
      : `<div class="mark" aria-hidden="true">${escapeHtml(initial)}</div>`,
  }
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_match, key: string) => markup[key] ?? "")
}

/** Writes the app's icon into `dir` as `icon.png`; on macOS, drawn the way macOS draws app icons. */
async function writeIcon(dir: string, png: Uint8Array): Promise<string> {
  const icon = join(dir, "icon.png")
  if (process.platform !== "darwin") {
    await writeFile(icon, png)
    return icon
  }
  // The original goes beside the app, not in it: everything in the app's directory ships.
  const source = join(dir, "..", "icon-source.png")
  await writeFile(source, png)
  await drawMacIcon(source, icon)
  return icon
}

async function readProjectVersion(projectRoot: string): Promise<string> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf-8"))
    const version = (manifest as { readonly version?: unknown } | null)?.version
    return typeof version === "string" ? version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
