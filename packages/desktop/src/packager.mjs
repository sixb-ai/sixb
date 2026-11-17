// Runs `@electron/packager` with the options `buildDesktopApp` passes as JSON. Started under
// Electron's own Node, not Bun: see `packageApp`.
import { packager } from "@electron/packager"

const { runnerEntitlements, ...options } = JSON.parse(process.argv[2])

// A function, which JSON can't carry: the runner gets its own entitlements, everything else the
// signer's defaults for Electron.
if (options.osxSign && runnerEntitlements) {
  options.osxSign.optionsForFile = (file) =>
    file.includes("/Contents/Resources/runner/") ? { entitlements: runnerEntitlements } : undefined
}

await packager(options)
