import {
  BrokerCursorExpiredError,
  type LogLevel,
  type LogRunKind,
  type LogRunRef,
  type OntologySource,
  type Sixb,
  type StoredLogLine,
} from "@sixb/core"

const MAX_CLIENT_RECORDS = 1_000
const MAX_CLIENT_BYTES = 1_048_576
const MAX_SOCKET_BUFFERED_BYTES = 1_048_576
const MAX_BATCH_RECORDS = 100
const FLUSH_DELAY_MS = 10
const READ_PAGE_SIZE = 500

interface LogSocket {
  send(message: string): unknown
  close(code?: number, reason?: string): unknown
  readonly raw?: unknown
}

export interface LogSubscriptionFilter {
  readonly kinds?: readonly LogRunKind[]
  readonly levels?: readonly LogLevel[]
  readonly run?: LogRunRef
  readonly afterCursor?: string
}

interface ClientState {
  readonly ws: LogSocket
  readonly filter: LogSubscriptionFilter
  readonly queue: StoredLogLine[]
  readonly queuedCursors: Set<string>
  readonly pendingLive: StoredLogLine[]
  readonly pendingCursors: Set<string>
  readonly replayedPendingCursors: Set<string>
  queuedBytes: number
  pendingBytes: number
  flushTimer: ReturnType<typeof setTimeout> | null
  catchingUp: boolean
  closed: boolean
}

/**
 * One broker subscription per server/project, multiplexed to all connected
 * clients. Each client has a bounded queue so a slow socket cannot retain an
 * unbounded portion of the process heap.
 */
export class LogSubscriptionHub {
  private readonly clients = new Map<object, ClientState>()
  private startPromise: Promise<void> | null = null
  private unsubscribeBroker: (() => void) | null = null
  private closed = false

  constructor(private readonly sixb: Sixb<readonly OntologySource[]>) {}

  async subscribe(
    key: object,
    ws: LogSocket,
    filter: LogSubscriptionFilter,
    onSubscribed: () => void
  ): Promise<void> {
    await this.ensureStarted()
    this.unsubscribe(key)

    const state: ClientState = {
      ws,
      filter,
      queue: [],
      queuedCursors: new Set(),
      pendingLive: [],
      pendingCursors: new Set(),
      replayedPendingCursors: new Set(),
      queuedBytes: 0,
      pendingBytes: 0,
      flushTimer: null,
      catchingUp: filter.afterCursor !== undefined,
      closed: false,
    }
    this.clients.set(key, state)
    onSubscribed()

    if (state.catchingUp) {
      void this.catchUp(key, state)
    }
  }

  unsubscribe(key: object): void {
    const state = this.clients.get(key)
    if (!state) return
    state.closed = true
    if (state.flushTimer) clearTimeout(state.flushTimer)
    this.clients.delete(key)
  }

  async close(): Promise<void> {
    this.closed = true
    this.unsubscribeBroker?.()
    this.unsubscribeBroker = null
    for (const key of this.clients.keys()) this.unsubscribe(key)
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("Log subscription hub is closed")
    if (!this.startPromise) {
      this.startPromise = this.sixb.logs
        .subscribe({ from: "latest" }, (lines) => this.deliverLive(lines))
        .then((unsubscribe) => {
          if (this.closed) unsubscribe()
          else this.unsubscribeBroker = unsubscribe
        })
        .catch((error) => {
          this.startPromise = null
          throw error
        })
    }
    await this.startPromise
  }

  private deliverLive(lines: readonly StoredLogLine[]): void {
    for (const state of this.clients.values()) {
      for (const line of lines) {
        if (!matches(line, state.filter)) continue
        if (state.catchingUp) this.enqueuePendingLive(state, line)
        else this.enqueue(state, line)
      }
    }
  }

  private async catchUp(key: object, state: ClientState): Promise<void> {
    let afterCursor = state.filter.afterCursor
    try {
      let hasMore = true
      while (hasMore) {
        const page = await this.sixb.logs.read({
          afterCursor,
          limit: READ_PAGE_SIZE,
          kinds: state.filter.kinds,
          levels: state.filter.levels,
          run: state.filter.run,
        })
        if (state.closed || this.clients.get(key) !== state) return

        for (const line of page.lines) {
          if (state.pendingCursors.has(line.cursor)) {
            state.replayedPendingCursors.add(line.cursor)
          }
          this.enqueue(state, line)
        }
        if (state.closed) return
        afterCursor = page.cursor ?? afterCursor
        hasMore = page.hasMore
        if (hasMore && !page.cursor) {
          throw new Error("Log broker returned hasMore without a cursor")
        }
      }

      state.catchingUp = false
      const pendingLive = [...state.pendingLive]
      const replayedPendingCursors = new Set(state.replayedPendingCursors)
      state.pendingLive.length = 0
      state.pendingCursors.clear()
      state.replayedPendingCursors.clear()
      state.pendingBytes = 0
      for (const line of pendingLive) {
        if (!replayedPendingCursors.has(line.cursor)) this.enqueue(state, line)
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
          const latest = await this.sixb.logs.tail({ limit: 1 })
          this.send(state, {
            type: "reset",
            reason: "cursor_expired",
            cursor: latest.lines.at(-1)?.cursor ?? latest.cursor,
          })
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

  private enqueue(state: ClientState, line: StoredLogLine): void {
    if (state.closed || state.queuedCursors.has(line.cursor)) return
    const bytes = encodedBytes(line)
    if (
      state.queue.length + state.pendingLive.length >= MAX_CLIENT_RECORDS ||
      state.queuedBytes + state.pendingBytes + bytes > MAX_CLIENT_BYTES
    ) {
      this.fail(state, "Log stream client is too slow; reconnect from the last cursor.", 1013)
      return
    }

    state.queue.push(line)
    state.queuedCursors.add(line.cursor)
    state.queuedBytes += bytes
    this.scheduleFlush(state)
  }

  private enqueuePendingLive(state: ClientState, line: StoredLogLine): void {
    if (state.closed || state.pendingCursors.has(line.cursor)) return
    const bytes = encodedBytes(line)
    if (
      state.queue.length + state.pendingLive.length >= MAX_CLIENT_RECORDS ||
      state.queuedBytes + state.pendingBytes + bytes > MAX_CLIENT_BYTES
    ) {
      this.fail(state, "Log stream client is too slow; reconnect from the last cursor.", 1013)
      return
    }
    state.pendingLive.push(line)
    state.pendingCursors.add(line.cursor)
    state.pendingBytes += bytes
  }

  private scheduleFlush(state: ClientState): void {
    if (state.closed || state.flushTimer) return
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null
      this.flush(state)
    }, FLUSH_DELAY_MS)
  }

  private flush(state: ClientState): void {
    if (state.closed || state.queue.length === 0) return
    if (socketBufferedAmount(state.ws) > MAX_SOCKET_BUFFERED_BYTES) {
      this.scheduleFlush(state)
      return
    }

    const lines = state.queue.splice(0, MAX_BATCH_RECORDS)
    for (const line of lines) {
      state.queuedCursors.delete(line.cursor)
      state.queuedBytes -= encodedBytes(line)
    }
    this.send(state, { type: "logs", logs: lines })
    if (state.queue.length > 0) this.scheduleFlush(state)
  }

  private send(state: ClientState, payload: unknown): void {
    if (state.closed) return
    try {
      state.ws.send(JSON.stringify(payload))
    } catch (error) {
      this.fail(state, error instanceof Error ? error.message : String(error), 1011)
    }
  }

  private fail(state: ClientState, message: string, closeCode: number): void {
    if (state.closed) return
    try {
      state.ws.send(JSON.stringify({ type: "error", message }))
    } catch {
      // The close below is still required when the error frame cannot be sent.
    }
    state.closed = true
    if (state.flushTimer) clearTimeout(state.flushTimer)
    for (const [key, candidate] of this.clients) {
      if (candidate === state) this.clients.delete(key)
    }
    try {
      state.ws.close(
        closeCode,
        closeCode === 1013 ? "Log stream backpressure" : "Log stream failure"
      )
    } catch {
      // Socket is already gone.
    }
  }
}

function matches(line: StoredLogLine, filter: LogSubscriptionFilter): boolean {
  if (filter.run) {
    if (line.context.run.kind !== filter.run.kind || line.context.run.id !== filter.run.id) {
      return false
    }
  }
  if (filter.kinds && !filter.kinds.includes(line.context.run.kind)) return false
  if (filter.levels && !filter.levels.includes(line.level)) return false
  return true
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function socketBufferedAmount(ws: LogSocket): number {
  const raw = ws.raw
  if (!raw || typeof raw !== "object" || !("bufferedAmount" in raw)) return 0
  const bufferedAmount = (raw as { bufferedAmount?: unknown }).bufferedAmount
  return typeof bufferedAmount === "number" ? bufferedAmount : 0
}
