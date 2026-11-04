// What `@sixb/desktop` compiles into a desktop app: `<binary> <api-url> <client-name>`.
import { runDesktopRunner } from "./desktop-runner"

const [apiUrl, clientName] = process.argv.slice(2)
if (!apiUrl || !clientName) {
  console.error("[SixbCLI] Usage: <binary> <api-url> <client-name>")
  process.exit(2)
}
await runDesktopRunner({ apiUrl, clientName })
