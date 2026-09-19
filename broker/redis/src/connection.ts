import { RedisClient, type RedisOptions } from "bun"
import { RedisBrokerError } from "./errors"

export interface RedisBrokerConnectionOptions extends RedisOptions {
  readonly url?: string
  /**
   * Bound on one command through the shared client. Defaults to 30 seconds.
   *
   * Bun bounds connecting with `connectionTimeout` and an idle socket with `idleTimeout`, but
   * neither bounds a command that was sent and never answered.
   */
  readonly commandTimeoutMs?: number
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface RedisBrokerCommandClient {
  exists(key: string): Promise<boolean>
  hmget(key: string, fields: string[]): Promise<Array<string | null>>
  send(command: string, args: string[]): Promise<unknown>
}

export interface RedisBrokerClient extends RedisBrokerCommandClient {
  connect(): Promise<void>
  close(): void
}

type RedisBrokerClientFactory = (
  url: string | undefined,
  options: RedisOptions | undefined
) => RedisBrokerClient

const createRedisBrokerClient: RedisBrokerClientFactory = (url, options) =>
  new RedisClient(url, options)

/**
 * Lazily manages Redis clients for the broker.
 *
 * The main client handles ordinary commands. Blocking `XREAD` subscriptions get
 * dedicated clients so a blocked subscription cannot starve append/read calls.
 */
export class RedisConnectionManager {
  private readonly controller = new AbortController()
  private readonly url: string | undefined
  private readonly options: RedisOptions | undefined
  private readonly commandTimeoutMs: number
  private connectPromise: Promise<RedisBrokerClient> | undefined
  private client: RedisBrokerClient | undefined
  private commandQueue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    options: RedisBrokerConnectionOptions = {},
    private readonly clientFactory: RedisBrokerClientFactory = createRedisBrokerClient
  ) {
    const { url, commandTimeoutMs, ...redisOptions } = options
    this.url = url
    this.commandTimeoutMs = timerDurationMs(
      commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      "connection.commandTimeoutMs"
    )
    this.options = Object.keys(redisOptions).length === 0 ? undefined : redisOptions
  }

  private async connect(): Promise<RedisBrokerClient> {
    if (this.client !== undefined) {
      // Bun owns reconnects and offline queueing for the client. Keep returning
      // the same main client while it reconnects instead of opening duplicates.
      return this.client
    }
    if (this.connectPromise !== undefined) {
      return this.connectPromise
    }

    const connectPromise = this.openClient("Failed to connect to Redis").then((client) => {
      this.client = client
      this.connectPromise = undefined
      return client
    })
    this.connectPromise = connectPromise

    try {
      return await connectPromise
    } catch (error) {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined
      }
      throw error
    }
  }

  async createSubscriptionClient(signal?: AbortSignal): Promise<RedisBrokerClient> {
    this.assertOpen()
    // A blocking command belongs to one connection generation. Reconnecting the same Bun client
    // can leave its in-flight XREAD promise pending, so subscription pumps replace disposable
    // clients themselves and resume from their retained cursor.
    const client = await this.openClient(
      "Failed to connect Redis subscription client",
      {
        ...this.options,
        autoReconnect: false,
        enableOfflineQueue: false,
      },
      signal
    )
    if (signal?.aborted) {
      this.closeClient(client)
      throw new RedisBrokerError("subscription client connection was aborted")
    }
    if (this.closed) {
      this.closeClient(client)
      this.assertOpen()
    }
    return client
  }

  /**
   * Serializes commands sent through the shared main client.
   *
   * Subscription pumps use dedicated clients, but ordinary broker reads/appends share one
   * Bun Redis client. Keeping one in-flight command at a time avoids response interleaving
   * across mixed `send()` calls under concurrent API traffic.
   */
  async useCommandClient<T>(
    operation: (client: RedisBrokerCommandClient) => Promise<T>
  ): Promise<T> {
    this.assertOpen()

    const previous = this.commandQueue
    let release!: () => void
    this.commandQueue = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    try {
      this.assertOpen()
      const client = await this.connect()
      return await operation(this.boundedCommandClient(client))
    } finally {
      release()
    }
  }

  /** Bounds each command and replaces clients that reject it before sending. */
  boundedCommandClient(client: RedisBrokerClient): RedisBrokerCommandClient {
    // Keep the replacement for subsequent commands in the same operation. Replaying the whole
    // operation could duplicate earlier successful writes, even when this command was not sent.
    let activeClient = client
    const run = async <T>(
      command: string,
      execute: (current: RedisBrokerClient) => Promise<T>
    ): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.runWithCommandTimeout(activeClient, command, () =>
            execute(activeClient)
          )
        } catch (error) {
          // Subscription clients belong to their pump and must never borrow the shared client.
          if (activeClient !== this.client || !isUnsentCommandOnFailedConnection(error)) {
            throw error
          }
          this.discardClient(activeClient)
          // One fresh connection attempt per command; a continuing outage must still surface.
          if (attempt === 1) throw error
          this.assertOpen()
          activeClient = await this.connect()
        }
      }
    }
    return {
      exists: (key) => run("EXISTS", (current) => current.exists(key)),
      hmget: (key, fields) => run("HMGET", (current) => current.hmget(key, fields)),
      send: (command, args) => run(command, (current) => current.send(command, args)),
    }
  }

  /**
   * Bounds one command so a reply that never arrives cannot hold the shared queue forever.
   *
   * The timed-out client is discarded rather than reused: its missing reply may still arrive, and
   * a late reply on a shared connection can be matched to the wrong command.
   */
  private async runWithCommandTimeout<T>(
    client: RedisBrokerClient,
    command: string,
    execute: () => Promise<T>
  ): Promise<T> {
    const timeoutMs = this.commandTimeoutMs
    const pending = execute()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.discardClient(client)
            reportAbandonedCommand(command, pending, timeoutMs)
            reject(
              new RedisBrokerError(`Redis command ${command} did not respond within ${timeoutMs}ms`)
            )
          }, timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Closes an unusable client and forgets it when it is the shared command client. */
  private discardClient(client: RedisBrokerClient): void {
    if (this.client === client) {
      this.client = undefined
    }
    this.closeClient(client)
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.commandQueue
      return
    }
    this.closed = true
    this.controller.abort()
    await this.commandQueue

    const client = this.client
    this.client = undefined
    this.connectPromise = undefined
    if (client === undefined) {
      return
    }
    this.closeClient(client)
  }

  closeClient(client: RedisBrokerClient): void {
    try {
      client.close()
    } catch {
      // Closing is best-effort during unsubscribe and broker shutdown.
    }
  }

  private async openClient(
    errorMessage: string,
    options: RedisOptions | undefined = this.options,
    signal?: AbortSignal
  ): Promise<RedisBrokerClient> {
    const client = this.clientFactory(this.url ?? redisUrlFromEnvironment(), options)
    const signals = signal ? [signal, this.controller.signal] : [this.controller.signal]
    let candidateClosed = false
    let onAbort: (() => void) | undefined
    const closeCandidate = (): void => {
      if (candidateClosed) return
      candidateClosed = true
      this.closeClient(client)
    }

    try {
      const connecting = client.connect()
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          closeCandidate()
          reject(new Error("Redis client connection was aborted"))
        }
        for (const activeSignal of signals) {
          activeSignal.addEventListener("abort", onAbort, { once: true })
        }
        if (signals.some((activeSignal) => activeSignal.aborted)) onAbort()
      })
      await Promise.race([connecting, aborted])
      if (signals.some((activeSignal) => activeSignal.aborted)) {
        throw new Error("Redis client connection was aborted")
      }
      return client
    } catch (error) {
      closeCandidate()
      throw new RedisBrokerError(errorMessage, { cause: error })
    } finally {
      if (onAbort !== undefined) {
        for (const activeSignal of signals) {
          activeSignal.removeEventListener("abort", onAbort)
        }
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RedisBrokerError("broker connection has been closed")
    }
  }
}

/**
 * Bun rejects this command before enqueueing it when the native client has failed permanently.
 * The code alone is insufficient: other connection-closed errors can reject an in-flight write.
 * Keep this narrow; timeouts, disconnects, and Redis script errors must not replay writes.
 * Verified against Bun 1.4.2's send_rejection() and send():
 * https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/valkey_jsc/valkey.rs
 */
function isUnsentCommandOnFailedConnection(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "RedisError" &&
    "code" in error &&
    error.code === "ERR_REDIS_CONNECTION_CLOSED" &&
    error.message === "Connection has failed"
  )
}

/** Reports how an abandoned command ended, once its caller has already been failed. */
function reportAbandonedCommand(
  command: string,
  pending: Promise<unknown>,
  timeoutMs: number
): void {
  pending.then(
    () => {
      console.error(
        `[RedisBroker] ${command} abandoned after ${timeoutMs}ms succeeded afterwards. Its caller already observed a timeout; any side effects may have been applied.`
      )
    },
    (error: unknown) => {
      console.error(
        `[RedisBroker] ${command} abandoned after ${timeoutMs}ms then failed. The bound closed its client, so this may report that close rather than the original fault.`,
        error
      )
    }
  )
}

function timerDurationMs(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new RedisBrokerError(
      `${name} must be an integer between 1 and ${MAX_TIMER_DELAY_MS} milliseconds.`
    )
  }
  return value
}

function redisUrlFromEnvironment(): string | undefined {
  return process.env["REDIS_URL"] || process.env["VALKEY_URL"]
}
