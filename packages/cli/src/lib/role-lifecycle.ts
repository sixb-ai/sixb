import { appendFileSync } from "node:fs"

// Kept apart from `runtime.ts`, which imports every worker package: `app` serves static assets for
// as long as it runs and must not hold that module graph to reuse these helpers.

export type ShutdownSignal = "SIGINT" | "SIGTERM"

export interface RunUntilSignalOptions {
  /** Called if `SIGINT` arrives while a `SIGTERM` drain is already in progress. */
  readonly onInterrupt?: () => void
}

export async function stopQuietly(stopFn: (() => Promise<void>) | undefined | null): Promise<void> {
  if (!stopFn) return
  await stopFn().catch(() => {})
}

/** Reads an optional millisecond drain bound from `SIXB_DRAIN_TIMEOUT_MS`. */
export function resolveDrainTimeoutMs(fallbackMs: number): number {
  const raw = process.env.SIXB_DRAIN_TIMEOUT_MS?.trim()
  if (!raw) return fallbackMs
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("[SixbCLI] SIXB_DRAIN_TIMEOUT_MS must be a non-negative integer.")
  }
  return parsed
}

export async function runUntilSignal(
  onShutdown: (signal: ShutdownSignal) => Promise<void>,
  options: RunUntilSignalOptions = {}
): Promise<void> {
  // Test-only readiness hook: e2e tests detect that a long-running role finished
  // starting by watching for this marker, rather than on the wording of what the
  // role prints. Unset in production, so this is a no-op there.
  const readyLog = process.env.SIXB_CLI_TEST_READY_LOG
  if (readyLog) {
    appendFileSync(readyLog, `${JSON.stringify({ type: "role:ready" })}\n`, "utf-8")
  }

  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false

    const handle = (signal: ShutdownSignal) => {
      if (shuttingDown) {
        if (signal === "SIGINT") {
          process.off("SIGINT", onSigint)
          options.onInterrupt?.()
        }
        return
      }
      shuttingDown = true
      process.off("SIGTERM", onSigterm)
      if (signal === "SIGINT") process.off("SIGINT", onSigint)

      void Promise.resolve()
        .then(() => onShutdown(signal))
        .finally(() => {
          process.off("SIGINT", onSigint)
          process.off("SIGTERM", onSigterm)
          resolvePromise()
        })
    }

    const onSigint = () => handle("SIGINT")
    const onSigterm = () => handle("SIGTERM")
    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigterm)
  })
}
