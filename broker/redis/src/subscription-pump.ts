import type { BrokerRecord } from "@sixb/core/broker"
import type { RedisBrokerClient, RedisConnectionManager } from "./connection"
import { RedisBrokerError } from "./errors"
import { decodeRecord } from "./serialization"
import type { EnsuredStream } from "./stream-manager"
import { bodyFromEntry, parseXReadEntries, type RedisStreamEntry } from "./stream-replies"
import type { ActiveSubscription } from "./subscription-registry"

const WATCHDOG_GRACE_MS = 1_000
const RETRY_INITIAL_DELAY_MS = 100
const RETRY_MAX_DELAY_MS = 2_000

export interface RedisSubscriptionPumpOptions {
  readonly connectionManager: RedisConnectionManager
  readonly client: RedisBrokerClient
  readonly stream: EnsuredStream
  readonly names?: ReadonlySet<string>
  readonly keys?: ReadonlySet<string>
  readonly batchSize: number
  readonly blockMs: number
  readonly handler: (records: readonly BrokerRecord[]) => void
}

/** Owns one retained XREAD cursor and replaces its disposable client after connection failure. */
export class RedisSubscriptionPump implements ActiveSubscription {
  private readonly controller = new AbortController()
  private completion: Promise<void> = Promise.resolve()
  private client: RedisBrokerClient
  private cursor = "0-0"
  private started = false

  constructor(private readonly options: RedisSubscriptionPumpOptions) {
    this.client = options.client
  }

  start(cursor: string): void {
    if (this.started || this.controller.signal.aborted) return
    this.started = true
    this.cursor = cursor
    this.completion = this.run()
  }

  stop(): void {
    if (this.controller.signal.aborted) return
    this.controller.abort()
    this.options.connectionManager.closeClient(this.client)
  }

  async drain(): Promise<void> {
    await this.completion
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal
    let retryAttempt = 0

    try {
      while (!signal.aborted) {
        let entries: readonly RedisStreamEntry[]
        try {
          entries = await this.xread(signal)
          retryAttempt = 0
        } catch (error) {
          if (signal.aborted) break

          console.error("[RedisBroker] Subscription read failed; reconnecting:", error)
          this.options.connectionManager.closeClient(this.client)
          const replacement = await this.reconnect(retryAttempt, signal)
          if (!replacement) break

          this.client = replacement.client
          retryAttempt = replacement.nextAttempt
          continue
        }

        const records = this.decode(entries)
        if (records.length === 0) continue

        try {
          this.options.handler(records)
        } catch {
          // Handler failures are swallowed per the Broker subscribe contract.
        }
      }
    } finally {
      this.options.connectionManager.closeClient(this.client)
    }
  }

  private async reconnect(
    attempt: number,
    signal: AbortSignal
  ): Promise<{ readonly client: RedisBrokerClient; readonly nextAttempt: number } | undefined> {
    let nextAttempt = attempt

    while (!signal.aborted) {
      await sleep(retryDelay(nextAttempt), signal)
      nextAttempt += 1
      if (signal.aborted) return undefined

      try {
        const client = await this.options.connectionManager.createSubscriptionClient()
        return { client, nextAttempt }
      } catch (error) {
        if (!signal.aborted) {
          console.error("[RedisBroker] Failed to reconnect subscription client; retrying:", error)
        }
      }
    }

    return undefined
  }

  private async xread(signal: AbortSignal): Promise<readonly RedisStreamEntry[]> {
    const timeoutMs = this.options.blockMs + WATCHDOG_GRACE_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined

    try {
      const reply = await Promise.race([
        this.client.send("XREAD", [
          "COUNT",
          String(this.options.batchSize),
          "BLOCK",
          String(this.options.blockMs),
          "STREAMS",
          this.options.stream.keys.streamKey,
          this.cursor,
        ]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new RedisBrokerError(
                `Subscription read for stream "${this.options.stream.streamId}" did not finish within ${timeoutMs}ms.`
              )
            )
          }, timeoutMs)
        }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new RedisBrokerError("Subscription stopped."))
          signal.addEventListener("abort", onAbort, { once: true })
        }),
      ])
      return parseXReadEntries(reply)
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof RedisBrokerError) throw error
      throw new RedisBrokerError(
        `Failed to subscribe to stream "${this.options.stream.streamId}"`,
        { cause: error }
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort)
    }
  }

  private decode(entries: readonly RedisStreamEntry[]): readonly BrokerRecord[] {
    const records: BrokerRecord[] = []

    for (const entry of entries) {
      // Advance over filtered and malformed records so neither can wedge the retained cursor.
      this.cursor = entry.id

      let record: BrokerRecord
      try {
        record = decodeRecord({
          streamId: this.options.stream.streamId,
          body: bodyFromEntry(entry),
          cursor: entry.id,
          fallbackPublishedAt: new Date().toISOString(),
        })
      } catch (error) {
        console.error("[RedisBroker] Failed to decode subscribed record:", error)
        continue
      }

      if (!matchesFilters(record, this.options.names, this.options.keys)) continue
      records.push(record)
    }

    return records
  }
}

function retryDelay(attempt: number): number {
  return Math.min(RETRY_INITIAL_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}

function matchesFilters(
  record: BrokerRecord,
  names: ReadonlySet<string> | undefined,
  keys: ReadonlySet<string> | undefined
): boolean {
  return (
    (!names || (!!record.name && names.has(record.name))) &&
    (!keys || (!!record.key && keys.has(record.key)))
  )
}
