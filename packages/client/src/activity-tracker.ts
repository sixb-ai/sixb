import { clearActivityArrival, takeActivityArrival } from "./activity-attribution"
import { captureActivity, getActivityCaptureConfig } from "./generated/sdk.gen"
import type { CaptureActivityData, GetActivityCaptureConfigResponse } from "./generated/types.gen"

type EventInput = CaptureActivityData["body"]["events"][number]
export type ActivityAttribution = NonNullable<EventInput["attribution"]>

interface QueuedEvent {
  readonly event: EventInput
  readonly queuedAt: number
}

/** A response that refused a batch: its status, and the wait a 429 asked for. */
export class ActivityDeliveryError extends Error {
  readonly name = "ActivityDeliveryError"

  constructor(
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(`[SixbClient] Activity delivery was refused with status ${status}.`)
  }
}

export interface ActivityTrackerOptions {
  readonly document: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  > | null
  readonly load: (signal: AbortSignal) => Promise<GetActivityCaptureConfigResponse>
  /** Rejects with an `ActivityDeliveryError` when the API answers, with anything else when not. */
  readonly send: (events: EventInput[], signal: AbortSignal) => Promise<void>
  /** How this document was reached; sent once, with its first event. */
  readonly attribution?: ActivityAttribution
  readonly now?: () => number
  readonly warn?: (message: string) => void
}

const MAX_QUEUE = 100
const MAX_BATCH = 20
const MAX_AGE_MS = 60_000
const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 10_000
const FLUSH_DELAY_MS = 500
const PULSE_INTERVAL_MS = 30_000
const INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "scroll"] as const

/**
 * Sends page views and foreground activity for one authority. Events live in memory only: they
 * are never persisted, and never carried across a sign-in or another shared link.
 */
export class ActivityTracker {
  private readonly abort = new AbortController()
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private enabled = false
  private idleTimeoutMs = 30 * 60_000
  private route: string | null = null
  private queue: QueuedEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private pulseTimer: ReturnType<typeof setInterval> | undefined
  private pending: Promise<void> | undefined
  private failedAttempts = 0
  /** Epoch milliseconds before which a 429 asked not to send again. */
  private throttledUntil = 0
  /** Input since the last event: the next pulse reports it. */
  private active = false
  /** A navigation happened while hidden; it counts once the tab is visible. */
  private hiddenNavigation = false
  private lastInputAt = 0
  private arrivalSent = false

  constructor(private readonly options: ActivityTrackerOptions) {
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? ((message) => console.warn(message))
    void this.start()
  }

  /** The route pattern now shown, or `null` on a page that is not recorded. */
  page(route: string | null): void {
    this.route = route
    this.hiddenNavigation = route !== null
    if (!this.enabled || !this.visible() || route === null) {
      return
    }

    this.hiddenNavigation = false
    this.active = false
    this.lastInputAt = this.now()
    this.enqueue("page.view")
  }

  dispose(): void {
    this.enabled = false
    this.abort.abort()
    clearTimeout(this.flushTimer)
    clearInterval(this.pulseTimer)

    for (const type of INPUT_EVENTS) {
      this.options.document?.removeEventListener(type, this.onInput, { capture: true })
    }
    this.options.document?.removeEventListener("visibilitychange", this.onVisibility)

    this.queue = []
  }

  /** Sends the next batch. Concurrent calls share one request; tests call it directly. */
  flush(): Promise<void> {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined

    if (this.pending) {
      return this.pending
    }

    this.pending = this.sendBatch().finally(() => {
      this.pending = undefined
      if (this.queue.length > 0 && !this.abort.signal.aborted) {
        this.schedule(this.nextDelay())
      }
    })
    return this.pending
  }

  private nextDelay(): number {
    const throttled = this.throttledUntil - this.now()
    if (throttled > 0) {
      return throttled
    }
    return this.failedAttempts > 0 ? retryDelay(this.failedAttempts) : FLUSH_DELAY_MS
  }

  private async start(): Promise<void> {
    let config: GetActivityCaptureConfigResponse
    try {
      config = await this.request((signal) => this.options.load(signal))
    } catch {
      if (!this.abort.signal.aborted) {
        this.warn(
          "[SixbClient] Activity capture settings are unavailable; this visit is not recorded."
        )
      }
      return
    }

    if (this.abort.signal.aborted || !config.enabled) {
      return
    }

    this.enabled = true
    this.idleTimeoutMs = config.idleTimeoutMs

    for (const type of INPUT_EVENTS) {
      this.options.document?.addEventListener(type, this.onInput, { capture: true, passive: true })
    }
    this.options.document?.addEventListener("visibilitychange", this.onVisibility)
    this.pulseTimer = setInterval(this.onPulse, PULSE_INTERVAL_MS)

    if (this.route !== null) {
      this.page(this.route)
    }
  }

  private onPulse = (): void => {
    if (this.active && this.visible()) {
      this.active = false
      this.enqueue("visit.activity")
    }
  }

  private onInput = (event: Event): void => {
    // Synthetic events are scripts, not someone using the page.
    if (!event.isTrusted || !this.visible()) {
      return
    }

    const resumed = this.now() - this.lastInputAt >= this.idleTimeoutMs
    this.lastInputAt = this.now()

    if (resumed) {
      this.active = false
      this.enqueue("visit.activity")
    } else {
      this.active = true
    }
  }

  private onVisibility = (): void => {
    if (this.visible()) {
      this.lastInputAt = this.now()
      this.active = false
      // A navigation made while hidden is a page view; returning to the same page is activity.
      this.enqueue(this.hiddenNavigation ? "page.view" : "visit.activity")
      this.hiddenNavigation = false
      return
    }

    if (this.active) {
      this.active = false
      this.enqueue("visit.activity")
    }
    void this.flush()
  }

  private visible(): boolean {
    return this.options.document?.visibilityState === "visible"
  }

  private enqueue(type: EventInput["type"]): void {
    if (!this.enabled || this.route === null || this.abort.signal.aborted) {
      return
    }

    if (this.queue.length >= MAX_QUEUE) {
      this.dropped(1)
      return
    }

    this.queue.push({
      event: { id: crypto.randomUUID(), type, route: this.route, ...this.nextAttribution() },
      queuedAt: this.now(),
    })
    this.schedule(FLUSH_DELAY_MS)
  }

  /**
   * The arrival travels with the first event only; later events say `{}`, so a visit started by
   * inactivity reads as direct rather than inheriting an old campaign.
   */
  private nextAttribution(): { attribution?: ActivityAttribution } {
    const first = !this.arrivalSent
    this.arrivalSent = true

    if (!first) {
      return { attribution: {} }
    }
    return this.options.attribution === undefined ? {} : { attribution: this.options.attribution }
  }

  private schedule(delay: number): void {
    if (this.flushTimer !== undefined) {
      return
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, delay)
  }

  private async sendBatch(): Promise<void> {
    if (!this.enabled || this.abort.signal.aborted) {
      return
    }

    const fresh = this.queue.filter((item) => this.now() - item.queuedAt <= MAX_AGE_MS)
    if (fresh.length < this.queue.length) {
      this.dropped(this.queue.length - fresh.length)
      this.queue = fresh
    }

    const batch = this.queue.slice(0, MAX_BATCH)
    if (batch.length === 0 || this.now() < this.throttledUntil) {
      return
    }

    try {
      await this.request((signal) =>
        this.options.send(
          batch.map((item) => item.event),
          signal
        )
      )
      if (this.abort.signal.aborted) {
        return
      }

      this.queue.splice(0, batch.length)
      this.failedAttempts = 0
    } catch (error) {
      if (this.abort.signal.aborted) {
        return
      }

      if (error instanceof ActivityDeliveryError && error.status === 429) {
        // Wait as asked, at most as long as the events are kept.
        this.throttledUntil = this.now() + Math.min(error.retryAfterMs ?? MAX_AGE_MS, MAX_AGE_MS)
        return
      }

      // Another refusal would answer the same again: the batch is dropped, not retried.
      if (error instanceof ActivityDeliveryError && error.status >= 400 && error.status < 500) {
        this.queue.splice(0, batch.length)
        this.dropped(batch.length)
        this.failedAttempts = 0
        return
      }

      // A retry resends the same ids, so the server recognizes page views it already has.
      this.failedAttempts++
      if (this.failedAttempts >= MAX_ATTEMPTS) {
        this.queue.splice(0, batch.length)
        this.dropped(batch.length)
        this.failedAttempts = 0
      }
    }
  }

  private async request<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.abort.signal.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS)

    try {
      return await run(controller.signal)
    } finally {
      clearTimeout(timeout)
      this.abort.signal.removeEventListener("abort", abort)
    }
  }

  private dropped(count: number): void {
    // Never the route or ids: the warning is for the console, not a record of the visit.
    this.warn(
      `[SixbClient] Activity capture dropped ${count} event(s); visit history may be incomplete.`
    )
  }
}

function retryDelay(failedAttempts: number): number {
  return Math.min(10_000, 1_000 * 2 ** failedAttempts)
}

/** Reads a `Retry-After` in seconds; a date or anything else leaves the default wait. */
function retryAfterMs(value: string | null): number | undefined {
  const seconds = value === null ? Number.NaN : Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined
}

let active: ActivityTracker | undefined
// The page shown, kept across a start so the order of start and first render does not matter.
let shownRoute: string | null = null

/** Starts recording for the authority the bootstrap just established. */
export function startSixbActivityCapture(): void {
  const attribution = takeActivityArrival()
  active?.dispose()
  active = new ActivityTracker({
    attribution,
    document: typeof document === "undefined" ? null : document,
    load: async (signal) => (await getActivityCaptureConfig({ signal, throwOnError: true })).data,
    send: async (events, signal) => {
      const { response } = await captureActivity({ body: { events }, signal, keepalive: true })
      if (!response.ok) {
        throw new ActivityDeliveryError(
          response.status,
          retryAfterMs(response.headers.get("retry-after"))
        )
      }
    },
  })
  active.page(shownRoute)
}

/** Reports the route pattern now shown, or `null` on a page that is not recorded. */
export function recordSixbPageView(route: string | null): void {
  shownRoute = route
  active?.page(route)
}

export function stopSixbActivityCapture(): void {
  clearActivityArrival()
  active?.dispose()
  active = undefined
}
