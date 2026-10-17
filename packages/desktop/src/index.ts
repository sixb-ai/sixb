import { mkdir, readdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type DesktopAppOptions, desktopDir, writeDesktopApp } from "./generate"
import { bundleIdentifier } from "./identity"
import { run } from "./run"

export type { DesktopAppOptions } from "./generate"

export interface DesktopWindow {
  /** Resolves with Electron's exit code once the user quits it. */
  readonly exited: Promise<number>
  close(): void
}

export interface DesktopBuild {
  /** What to hand to users: a zip of the app on macOS, the app's folder elsewhere. */
  readonly path: string
  /** Whether it was signed and notarized, and so opens without a warning. */
  readonly signed: boolean
}

const packageRequire = createRequire(import.meta.url)
// From the package's `src`, like the shell: see `SHELL_SOURCE_DIR`.
const PACKAGER_SCRIPT = fileURLToPath(new URL("../src/packager.mjs", import.meta.url))

/** Opens the app in a desktop window. `sixb dev --desktop` calls this. */
export async function openDesktopApp(options: DesktopAppOptions): Promise<DesktopWindow> {
  const app = await writeDesktopApp(options)
  // Chromium writes plenty to stderr when all is well, so it goes to a file, named if the window
  // quits on its own with an error.
  const log = join(dirname(app.dir), "electron.log")
  const electron = Bun.spawn([electronBinary(), app.dir], {
    stdio: ["ignore", "ignore", Bun.file(log)],
  })
  let closing = false
  const exited = electron.exited.then((code) => {
    if (code !== 0 && !closing) {
      console.error(`[SixbDesktop] The desktop window quit with exit code ${code}. See ${log}.`)
    }
    return code
  })
  return {
    exited,
    close: () => {
      closing = true
      electron.kill()
    },
  }
}

/** Packages the app for this machine's platform. `sixb desktop build` calls this. */
export async function buildDesktopApp(options: DesktopAppOptions): Promise<DesktopBuild> {
  const app = await writeDesktopApp(options)
  const out = desktopDir(options.projectRoot, "dist")
  await rm(out, { recursive: true, force: true })

  const mac = process.platform === "darwin"
  const notarize = mac ? appleNotarization() : null
  const packaged = await packageApp({
    dir: app.dir,
    name: app.name,
    out,
    appBundleId: bundleIdentifier(options.appUrl),
    appVersion: app.version,
    electronVersion: (packageRequire("electron/package.json") as { readonly version: string })
      .version,
    ...(mac && app.icon ? { icon: await macIcon(app.icon) } : {}),
    // Signs with the Developer ID certificate in the keychain, which notarization requires.
    ...(notarize ? { osxSign: {}, osxNotarize: notarize } : {}),
  })
  if (!mac) return { path: packaged, signed: false }

  const name = (await readdir(packaged)).find((entry) => entry.endsWith(".app"))
  if (!name) throw new Error(`[SixbDesktop] The packaged app is missing from ${packaged}.`)
  const bundle = join(packaged, name)
  // Packaging breaks the ad-hoc signature Electron ships with. macOS calls a downloaded app with a
  // broken signature damaged, and offers no way to open it; signed ad hoc, it can be allowed.
  if (!notarize) {
    await run(["codesign", "--force", "--deep", "--sign", "-", bundle], "Could not sign the app.")
  }
  // `ditto`, not `zip`: it keeps the bundle's symlinks, and with them its signature.
  const zip = `${packaged}.zip`
  await run(["ditto", "-c", "-k", "--keepParent", bundle, zip], "Could not zip the app.")
  return { path: zip, signed: notarize !== null }
}

/**
 * An App Store Connect API key, which notarizes the app so macOS opens it without a warning.
 * Without one, the app is built unsigned.
 */
function appleNotarization(): {
  readonly appleApiKey: string
  readonly appleApiKeyId: string
  readonly appleApiIssuer: string
} | null {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env
  if (!APPLE_API_KEY && !APPLE_API_KEY_ID && !APPLE_API_ISSUER) return null
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    throw new Error(
      "[SixbDesktop] Set all of APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER to sign the " +
        "macOS app, or none of them to build it unsigned."
    )
  }
  return {
    appleApiKey: APPLE_API_KEY,
    appleApiKeyId: APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER,
  }
}

/**
 * The packager wants `.icns`: every size macOS shows, scaled from the 1024-pixel icon, in one file.
 * `sips` and `iconutil` ship with every Mac. Written beside the app, not in it: everything in the
 * app's directory ships inside the bundle.
 */
async function macIcon(png: string): Promise<string> {
  const desktop = dirname(dirname(png))
  const iconset = join(desktop, "icon.iconset")
  await rm(iconset, { recursive: true, force: true })
  await mkdir(iconset)
  const sizes = [16, 32, 128, 256, 512].flatMap((points) => [
    { name: `icon_${points}x${points}.png`, pixels: points },
    { name: `icon_${points}x${points}@2x.png`, pixels: points * 2 },
  ])
  await Promise.all(
    sizes.map(({ name, pixels }) =>
      run(
        ["sips", "-z", `${pixels}`, `${pixels}`, png, "--out", join(iconset, name)],
        "Could not scale the icon."
      )
    )
  )
  const icns = join(desktop, "icon.icns")
  await run(["iconutil", "-c", "icns", iconset, "-o", icns], "Could not convert the icon.")
  return icns
}

/**
 * Runs `@electron/packager` into `options.out`, which starts empty, and resolves with the one
 * directory it wrote there. Under Electron's own binary, which doubles as the Node the packager was
 * written for: under Bun, the packager fails whenever it verifies a download (its checksum
 * dependency does not load).
 */
async function packageApp(
  options: { readonly out: string } & Record<string, unknown>
): Promise<string> {
  const packager = Bun.spawn(
    [electronBinary(), PACKAGER_SCRIPT, JSON.stringify({ ...options, quiet: true })],
    {
      stdio: ["ignore", "inherit", "inherit"],
      // Without the second, Electron's file system reads the `app.asar` the packager writes as a
      // directory.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1" },
    }
  )
  if ((await packager.exited) !== 0) {
    throw new Error("[SixbDesktop] Packaging failed. See the output above.")
  }
  const [written] = await readdir(options.out)
  if (!written) throw new Error(`[SixbDesktop] The packager wrote nothing to ${options.out}.`)
  return join(options.out, written)
}

// Outside Electron, `require("electron")` is the path of the binary its install script fetched.
function electronBinary(): string {
  try {
    return packageRequire("electron") as string
  } catch {
    const electronDir = dirname(packageRequire.resolve("electron/package.json"))
    throw new Error(
      "[SixbDesktop] Electron's binary is missing: its install script did not run. " +
        `Run \`bun run --cwd ${electronDir} postinstall\`, then try again.`
    )
  }
}
