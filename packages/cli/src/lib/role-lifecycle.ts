import { appendFileSync } from "node:fs"

// Kept apart from `runtime.ts`, which imports every worker package: `atlas` and `app` serve static
// assets for as long as they run and must not hold that module graph to reuse these two helpers.

export async function stopQuietly(stopFn: (() => Promise<void>) | undefined | null): Promise<void> {
  if (!stopFn) return
  await stopFn().catch(() => {})
}

export async function runUntilSignal(onShutdown: () => Promise<void>): Promise<void> {
  // Test-only readiness hook: e2e tests detect that a long-running role finished
  // starting by watching for this marker. It avoids depending on Ink's rendered
  // output, which is suppressed when stdout is not a TTY (e.g. under CI). Unset in
  // production, so this is a no-op there.
  const readyLog = process.env.SIXB_CLI_TEST_READY_LOG
  if (readyLog) {
    appendFileSync(readyLog, `${JSON.stringify({ type: "role:ready" })}\n`, "utf-8")
  }

  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false

    const shutdown = async () => {
      if (shuttingDown) return
      shuttingDown = true
      await onShutdown()
      resolvePromise()
    }

    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
  })
}
