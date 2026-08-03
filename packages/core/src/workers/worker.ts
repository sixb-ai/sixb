import { SixbError } from "../errors"

// The budget rides out ~80s of continuous failure (0.1s -> 30s backoffs) before the worker is
// declared unhealthy, so a transient infra outage does not kill an otherwise healthy process.
const MAX_RESTARTS = 10
const RESTART_BACKOFF_MS = 100
const MAX_RESTART_BACKOFF_MS = 30_000
const STABLE_RUN_MS = 60_000

/** Base worker lifecycle with bounded restart supervision. */
export abstract class Worker {
  /** Base restart backoff. Overridable so budget-exhaustion tests do not wait out real backoffs. */
  protected readonly restartBackoffMs: number = RESTART_BACKOFF_MS
  private controller: AbortController | null = null
  private running: Promise<void> | null = null

  async start(): Promise<void> {
    if (this.controller) return

    this.controller = new AbortController()
    this.running = this.supervise(this.controller.signal)
    // `wait()` exposes terminal failure. Keep a handler attached for embedded callers that only use
    // start/stop, so an exhausted restart budget does not become an unhandled rejection.
    this.running.catch(() => {})
  }

  async stop(): Promise<void> {
    const controller = this.controller
    if (!controller) return

    controller.abort()
    await this.running?.catch(() => {})
    if (this.controller === controller) {
      this.controller = null
      this.running = null
    }
  }

  /** Resolves after stop and rejects if the bounded restart budget is exhausted. */
  wait(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  protected abstract run(signal: AbortSignal): Promise<void>

  private async supervise(signal: AbortSignal): Promise<void> {
    let restartCount = 0

    while (!signal.aborted) {
      const startedAt = Date.now()
      let failure: unknown

      try {
        await this.run(signal)
        if (signal.aborted) return
        failure = new Error(`[SixbWorker] ${this.constructor.name} stopped unexpectedly.`)
      } catch (error) {
        if (signal.aborted) return
        failure = error
      }

      if (Date.now() - startedAt >= STABLE_RUN_MS) {
        restartCount = 0
      }
      if (restartCount >= MAX_RESTARTS) {
        throw new SixbError(
          "runtime.unexpected",
          `[SixbWorker] ${this.constructor.name} is unhealthy after ${restartCount} restart attempt(s).`,
          { cause: failure, details: { workerName: this.constructor.name, restartCount } }
        )
      }

      const delayMs = Math.min(this.restartBackoffMs * 2 ** restartCount, MAX_RESTART_BACKOFF_MS)
      restartCount += 1
      await waitForAbort(delayMs, signal)
    }
  }
}

async function waitForAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}
