// What `@sixb/desktop` compiles into a desktop app: `<binary> <api-url> <client-name> [window-data]`.
import { runDesktopRunner } from "./desktop-runner"

const [apiUrl, clientName, windowData] = process.argv.slice(2)
if (!apiUrl || !clientName) {
  console.error("[SixbCLI] Usage: <binary> <api-url> <client-name> [window-data]")
  process.exit(2)
}
await runDesktopRunner({ apiUrl, clientName, ...(windowData ? { windowData } : {}) })
