import { SixbCliError } from "../lib/errors"
import { renderCliError } from "../ui"

/** The command stays only to say where cron went: a process manager left on it must see a failure. */
export async function runScheduler(): Promise<void> {
  await renderCliError(
    new SixbCliError("[SixbCLI] `sixb scheduler` no longer runs: `sixb orchestrator` runs cron.", {
      remediation:
        "Remove this process from your deployment and keep one `sixb orchestrator` running.",
    })
  )
  process.exit(1)
}
