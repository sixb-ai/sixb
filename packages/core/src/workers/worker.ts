import { type BackoffPolicy, backoffDelay, waitUnlessAborted } from "../shared/backoff"
import { WorkerUnhealthyError } from "./errors"

// The budget rides out ~80s of continuous failure (0.1s -> 30s backoffs) before the worker is
// declared unhealthy, so a transient infra outage does not kill an otherwise healthy process.
const MAX_RESTARTS = 10
const RESTART_BACKOFF: BackoffPolicy = { initialMs: 100, maxMs: 30_000 }
const STABLE_RUN_MS = 60_000

/** Base worker lifecycle with bounded restart supervision. */
export abstract class Worker {
  private controller: AbortController | null = null
  private drainController: AbortController | null = null
  private running: Promise<void> | null = null

  async start(): Promise<void> {
    if (this.controller) return

    const controller = new AbortController()
    const drainController = new AbortController()
    this.controller = controller
    this.drainController = drainController
    this.running = this.supervise(controller.signal, drainController.signal)
    // `wait()` exposes terminal failure. Keep a handler attached for embedded callers that only use
    // start/stop, so an exhausted restart budget does not become an unhandled rejection.
    this.running.catch(() => {})
  }

  async stop(): Promise<void> {
    const controller = this.controller
    if (!controller) return

    this.drainController?.abort()
    controller.abort()
    await this.running?.catch(() => {})
    if (this.controller === controller) {
      this.controller = null
      this.drainController = null
      this.running = null
    }
  }

  /** Resolves after stop and rejects if the bounded restart budget is exhausted. */
  wait(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  /** Aborts when `drainRunning` or `stop` begins, before `run`'s abort signal fires. */
  protected get drainSignal(): AbortSignal {
    return this.drainController?.signal ?? AbortSignal.abort()
  }

  /**
   * Stops new work through `drainSignal` and waits for `run` to finish, falling back to `stop()`
   * when `timeoutMs` elapses first. Returns `true` when `run` finished without aborting `signal`.
   */
  protected async drainRunning(timeoutMs?: number): Promise<boolean> {
    const controller = this.controller
    if (!controller) return true

    this.drainController?.abort()
    const running = (this.running ?? Promise.resolve()).then(
      () => true,
      () => true
    )

    if (timeoutMs !== undefined && timeoutMs <= 0) {
      await this.stop()
      return false
    }

    let finished = false
    if (timeoutMs === undefined) {
      finished = await running
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        finished = await Promise.race([
          running,
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    if (!finished) {
      await this.stop()
      return false
    }

    if (this.controller === controller) {
      this.controller = null
      this.drainController = null
      this.running = null
    }
    return !controller.signal.aborted
  }

  protected abstract run(signal: AbortSignal): Promise<void>

  private async supervise(signal: AbortSignal, drainSignal: AbortSignal): Promise<void> {
    let restartCount = 0

    while (!signal.aborted && !drainSignal.aborted) {
      const startedAt = Date.now()
      let failure: unknown

      try {
        await this.run(signal)
        if (signal.aborted || drainSignal.aborted) return
        failure = new Error(`[SixbWorker] ${this.constructor.name} stopped unexpectedly.`)
      } catch (error) {
        if (signal.aborted || drainSignal.aborted) return
        failure = error
      }

      if (Date.now() - startedAt >= STABLE_RUN_MS) {
        restartCount = 0
      }
      if (restartCount >= MAX_RESTARTS) {
        throw new WorkerUnhealthyError(this.constructor.name, restartCount, { cause: failure })
      }

      const delayMs = backoffDelay(restartCount, RESTART_BACKOFF)
      restartCount += 1
      await waitUnlessAborted(delayMs, AbortSignal.any([signal, drainSignal]))
    }
  }
}
