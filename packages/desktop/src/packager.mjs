// Runs `@electron/packager` with the options `buildDesktopApp` passes as JSON. Started under
// Electron's own Node, not Bun: see `packageApp`.
import { packager } from "@electron/packager"

await packager(JSON.parse(process.argv[2]))
