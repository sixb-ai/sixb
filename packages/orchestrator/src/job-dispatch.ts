import { reportOrchestratorDispatchFailure } from "@sixb/core/internal/error-reporting"

/** A dispatch writes one run and publishes one job. Past this it hangs: count it as failed. */
const ATTEMPT_TIMEOUT_MS = 30_000

// 250 ms doubling to 10 s: about five minutes in all, which outlasts a database failover or a
// broker restart, so that an outage loses nothing.
const MAX_ATTEMPTS = 36
const RETRY_INITIAL_DELAY_MS = 250
const RETRY_MAX_DELAY_MS = 10_000

/** Past this many jobs in retry the subscription waits: the backlog stays in the broker. */
const MAX_RETRYING_JOBS = 64

/** One thing an event asks for: one run of one primitive. */
export interface DispatchJob {
  readonly event: { readonly id: string; readonly type: string }
  /** What the job would start, such as `pipeline:daily-sales`. */
  readonly target: string
  dispatch(): Promise<void>
}

export interface JobDispatchInput {
  readonly projectId: string
  readonly reporter: object
  readonly signal: AbortSignal
}

/**
 * Dispatches each job on its own, so that one job that keeps failing costs the others one attempt.
 * Jobs go out in order, one at a time. A job that fails leaves the line and retries beside it, with
 * backoff, until `MAX_ATTEMPTS`: then it is reported and dropped. Dropping is what keeps one bad
 * route from holding the others for good: `README.md` says what each kind of job can lose.
 */
export class JobDispatch {
  private readonly retrying = new Set<Promise<void>>()

  constructor(private readonly input: JobDispatchInput) {}

  /** Resolves once each job was dispatched or left to retry. */
  async all(jobs: readonly DispatchJob[]): Promise<void> {
    for (const job of jobs) {
      if (this.input.signal.aborted) return

      await this.one(job)
    }
  }

  /** Waits for the retries in flight. They end at once when the signal aborts. */
  async drain(): Promise<void> {
    await Promise.all(this.retrying)
  }

  private async one(job: DispatchJob): Promise<void> {
    const failure = await attempt(job)
    if (failure === null) return

    while (this.retrying.size >= MAX_RETRYING_JOBS) await Promise.race(this.retrying)

    const retry = this.retry(job, failure.error).finally(() => this.retrying.delete(retry))
    this.retrying.add(retry)
  }

  private async retry(job: DispatchJob, firstError: unknown): Promise<void> {
    const { signal } = this.input
    let error = firstError

    for (let attempts = 1; attempts < MAX_ATTEMPTS; attempts++) {
      console.error(
        `[SixbOrchestrator] Dispatch failed (attempt ${attempts}, target=${job.target}, eventId=${job.event.id}); retrying:`,
        error
      )

      await sleep(retryDelay(attempts - 1), signal)
      if (signal.aborted) return

      const failure = await attempt(job)
      if (failure === null) return
      error = failure.error
    }

    reportOrchestratorDispatchFailure(this.input.reporter, error, {
      projectId: this.input.projectId,
      eventId: job.event.id,
      eventType: job.event.type,
      target: job.target,
      attempts: MAX_ATTEMPTS,
    })
  }
}

async function attempt(job: DispatchJob): Promise<{ readonly error: unknown } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[SixbOrchestrator] Dispatch hung past ${ATTEMPT_TIMEOUT_MS}ms.`)),
      ATTEMPT_TIMEOUT_MS
    )
  })

  try {
    await Promise.race([job.dispatch(), timedOut])
    return null
  } catch (error) {
    return { error }
  } finally {
    clearTimeout(timer)
  }
}

function retryDelay(retry: number): number {
  return Math.min(RETRY_INITIAL_DELAY_MS * 2 ** retry, RETRY_MAX_DELAY_MS)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }

    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}
