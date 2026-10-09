import { BrokerCursorExpiredError } from "@sixb/core/broker"

const MAX_CLIENT_RECORDS = 1_000
const MAX_CLIENT_BYTES = 1_048_576
const MAX_SOCKET_BUFFERED_BYTES = 1_048_576
const MAX_BATCH_RECORDS = 100
const FLUSH_DELAY_MS = 10

interface HubSocket {
  send(message: string): unknown
  close(code?: number, reason?: string): unknown
  readonly raw?: unknown
}

interface HubRecord {
  readonly cursor: string
}

/** One retained broker stream, as the hub consumes and frames it. */
export interface HubSource<T extends HubRecord> {
  /** Delivers records appended after the call. */
  subscribe(deliver: (records: readonly T[]) => void): Promise<() => void>
  /** Socket frames for one flushed batch, in order. */
  frames(records: readonly T[]): readonly unknown[]
  /** Frame for a client whose replay cursor left retention. Live delivery continues after it. */
  expired(): Promise<unknown>
}

/** One socket's view of the stream. */
export interface HubSubscription<T extends HubRecord> {
  matches(record: T): boolean
  /** Replays retained records after `afterCursor` (or from the oldest) before live ones. */
  readonly replay?: {
    readonly afterCursor: string | undefined
    read(afterCursor: string | undefined): Promise<{
      readonly records: readonly T[]
      readonly cursor?: string
      readonly hasMore: boolean
    }>
  }
}

interface ClientState<T extends HubRecord> {
  readonly ws: HubSocket
  readonly subscription: HubSubscription<T>
  readonly queue: T[]
  readonly queuedCursors: Set<string>
  readonly pendingLive: T[]
  readonly pendingCursors: Set<string>
  readonly replayedPendingCursors: Set<string>
  queuedBytes: number
  pendingBytes: number
  flushTimer: ReturnType<typeof setTimeout> | null
  readonly queueProgressWaiters: Set<() => void>
  catchingUp: boolean
  closed: boolean
}

/**
 * One broker subscription per server/project and stream, multiplexed to all connected clients
 * and released when the last one leaves. Each client has a bounded queue so a slow socket cannot
 * retain an unbounded portion of the process heap.
 */
export class SubscriptionHub<T extends HubRecord> {
  private readonly clients = new Map<object, ClientState<T>>()
  private readonly subscriptionGenerations = new WeakMap<object, number>()
  private started: Promise<() => void> | null = null
  private closed = false

  constructor(private readonly source: HubSource<T>) {}

  async subscribe(
    key: object,
    ws: HubSocket,
    subscription: HubSubscription<T>,
    onSubscribed: () => void
  ): Promise<void> {
    if (this.closed) throw new Error("Subscription hub is closed")
    const generation = this.nextSubscriptionGeneration(key)
    this.removeClient(key)

    // The last client leaving while this waits releases the subscription it waited for.
    let started: Promise<() => void>
    do {
      started = this.start()
      try {
        await started
      } catch (error) {
        if (this.closed || !this.isCurrentSubscription(key, generation)) return
        throw error
      }
      if (this.closed || !this.isCurrentSubscription(key, generation)) return
    } while (started !== this.started)

    const state: ClientState<T> = {
      ws,
      subscription,
      queue: [],
      queuedCursors: new Set(),
      pendingLive: [],
      pendingCursors: new Set(),
      replayedPendingCursors: new Set(),
      queuedBytes: 0,
      pendingBytes: 0,
      flushTimer: null,
      queueProgressWaiters: new Set(),
      catchingUp: subscription.replay !== undefined,
      closed: false,
    }
    this.clients.set(key, state)
    onSubscribed()

    if (subscription.replay) {
      void this.catchUp(key, state, subscription.replay)
    }
  }

  unsubscribe(key: object): void {
    this.nextSubscriptionGeneration(key)
    this.removeClient(key)
  }

  private removeClient(key: object): void {
    const state = this.clients.get(key)
    if (!state) return
    state.closed = true
    if (state.flushTimer) clearTimeout(state.flushTimer)
    this.notifyQueueProgress(state)
    this.deleteClient(key)
  }

  private deleteClient(key: object): void {
    this.clients.delete(key)
    if (this.clients.size === 0) this.release()
  }

  private nextSubscriptionGeneration(key: object): number {
    const generation = (this.subscriptionGenerations.get(key) ?? 0) + 1
    this.subscriptionGenerations.set(key, generation)
    return generation
  }

  private isCurrentSubscription(key: object, generation: number): boolean {
    return this.subscriptionGenerations.get(key) === generation
  }

  async close(): Promise<void> {
    this.closed = true
    for (const key of this.clients.keys()) this.unsubscribe(key)
    this.release()
  }

  private start(): Promise<() => void> {
    if (this.closed) return Promise.reject(new Error("Subscription hub is closed"))
    if (!this.started) {
      const started = this.source.subscribe((records) => this.deliverLive(records))
      started.catch(() => {
        if (this.started === started) this.started = null
      })
      this.started = started
    }
    return this.started
  }

  private release(): void {
    const started = this.started
    this.started = null
    started?.then(
      (unsubscribe) => unsubscribe(),
      () => undefined
    )
  }

  private deliverLive(records: readonly T[]): void {
    for (const state of this.clients.values()) {
      for (const record of records) {
        if (!state.subscription.matches(record)) continue
        if (state.catchingUp) this.enqueuePendingLive(state, record)
        else this.enqueue(state, record)
      }
    }
  }

  private async catchUp(
    key: object,
    state: ClientState<T>,
    replay: NonNullable<HubSubscription<T>["replay"]>
  ): Promise<void> {
    let afterCursor = replay.afterCursor
    try {
      let hasMore = true
      while (hasMore) {
        const page = await replay.read(afterCursor)
        if (state.closed || this.clients.get(key) !== state) return

        for (const record of page.records) {
          if (state.pendingCursors.has(record.cursor)) {
            state.replayedPendingCursors.add(record.cursor)
          }
          if (!state.subscription.matches(record)) continue
          if (!(await this.enqueueReplay(state, record))) return
        }
        if (state.closed) return
        afterCursor = page.cursor ?? afterCursor
        hasMore = page.hasMore
        if (hasMore && !page.cursor) {
          throw new Error("Broker returned hasMore without a cursor")
        }
      }

      state.catchingUp = false
      const pendingLive = [...state.pendingLive]
      const replayedPendingCursors = new Set(state.replayedPendingCursors)
      state.pendingLive.length = 0
      state.pendingCursors.clear()
      state.replayedPendingCursors.clear()
      state.pendingBytes = 0
      for (const record of pendingLive) {
        if (!replayedPendingCursors.has(record.cursor)) this.enqueue(state, record)
      }
    } catch (error) {
      if (state.closed || this.clients.get(key) !== state) return
      state.catchingUp = false
      state.pendingLive.length = 0
      state.pendingCursors.clear()
      state.replayedPendingCursors.clear()
      state.pendingBytes = 0

      if (error instanceof BrokerCursorExpiredError) {
        try {
          this.send(state, await this.source.expired())
        } catch (resetError) {
          this.fail(
            state,
            resetError instanceof Error ? resetError.message : String(resetError),
            1011
          )
        }
        return
      }

      this.fail(state, error instanceof Error ? error.message : String(error), 1011)
    }
  }

  private enqueue(state: ClientState<T>, record: T): void {
    if (state.closed || state.queuedCursors.has(record.cursor)) return
    const bytes = encodedBytes(record)
    if (!hasQueueCapacity(state, bytes)) {
      this.fail(state, "Stream client is too slow; reconnect from the last cursor.", 1013)
      return
    }

    this.pushQueuedRecord(state, record, bytes)
  }

  private async enqueueReplay(state: ClientState<T>, record: T): Promise<boolean> {
    if (state.closed) return false
    if (state.queuedCursors.has(record.cursor)) return true
    const bytes = encodedBytes(record)

    while (!hasQueueCapacity(state, bytes)) {
      // Replay is an internal producer and can pause while already-queued replay
      // batches drain. Pending live records cannot drain until replay finishes,
      // so a queue containing only pending live records has no forward progress.
      if (state.queue.length === 0 || socketBufferedAmount(state.ws) > MAX_SOCKET_BUFFERED_BYTES) {
        this.fail(state, "Stream client is too slow; reconnect from the last cursor.", 1013)
        return false
      }
      this.scheduleFlush(state)
      await this.waitForQueueProgress(state)
      if (state.closed) return false
    }

    this.pushQueuedRecord(state, record, bytes)
    return !state.closed
  }

  private pushQueuedRecord(state: ClientState<T>, record: T, bytes: number): void {
    state.queue.push(record)
    state.queuedCursors.add(record.cursor)
    state.queuedBytes += bytes
    this.scheduleFlush(state)
  }

  private enqueuePendingLive(state: ClientState<T>, record: T): void {
    if (state.closed || state.pendingCursors.has(record.cursor)) return
    const bytes = encodedBytes(record)
    if (!hasQueueCapacity(state, bytes)) {
      this.fail(state, "Stream client is too slow; reconnect from the last cursor.", 1013)
      return
    }
    state.pendingLive.push(record)
    state.pendingCursors.add(record.cursor)
    state.pendingBytes += bytes
  }

  private scheduleFlush(state: ClientState<T>): void {
    if (state.closed || state.flushTimer) return
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null
      this.flush(state)
    }, FLUSH_DELAY_MS)
  }

  private flush(state: ClientState<T>): void {
    if (state.closed || state.queue.length === 0) return
    if (socketBufferedAmount(state.ws) > MAX_SOCKET_BUFFERED_BYTES) {
      this.scheduleFlush(state)
      return
    }

    const records = state.queue.splice(0, MAX_BATCH_RECORDS)
    for (const record of records) {
      state.queuedCursors.delete(record.cursor)
      state.queuedBytes -= encodedBytes(record)
    }
    this.notifyQueueProgress(state)
    for (const frame of this.source.frames(records)) this.send(state, frame)
    if (state.queue.length > 0) this.scheduleFlush(state)
  }

  private waitForQueueProgress(state: ClientState<T>): Promise<void> {
    return new Promise((resolve) => state.queueProgressWaiters.add(resolve))
  }

  private notifyQueueProgress(state: ClientState<T>): void {
    const waiters = [...state.queueProgressWaiters]
    state.queueProgressWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  private send(state: ClientState<T>, payload: unknown): void {
    if (state.closed) return
    try {
      state.ws.send(JSON.stringify(payload))
    } catch (error) {
      this.fail(state, error instanceof Error ? error.message : String(error), 1011)
    }
  }

  private fail(state: ClientState<T>, message: string, closeCode: number): void {
    if (state.closed) return
    try {
      state.ws.send(JSON.stringify({ type: "error", message }))
    } catch {
      // The close below is still required when the error frame cannot be sent.
    }
    state.closed = true
    if (state.flushTimer) clearTimeout(state.flushTimer)
    this.notifyQueueProgress(state)
    for (const [key, candidate] of this.clients) {
      if (candidate === state) this.deleteClient(key)
    }
    try {
      state.ws.close(closeCode, closeCode === 1013 ? "Stream backpressure" : "Stream failure")
    } catch {
      // Socket is already gone.
    }
  }
}

function hasQueueCapacity(state: ClientState<HubRecord>, bytes: number): boolean {
  return (
    state.queue.length + state.pendingLive.length < MAX_CLIENT_RECORDS &&
    state.queuedBytes + state.pendingBytes + bytes <= MAX_CLIENT_BYTES
  )
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function socketBufferedAmount(ws: HubSocket): number {
  const raw = ws.raw
  if (!raw || typeof raw !== "object" || !("bufferedAmount" in raw)) return 0
  const bufferedAmount = (raw as { bufferedAmount?: unknown }).bufferedAmount
  return typeof bufferedAmount === "number" ? bufferedAmount : 0
}
