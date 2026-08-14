import { RedisClient, type RedisOptions } from "bun"
import { RedisBrokerError } from "./errors"

export interface RedisBrokerConnectionOptions extends RedisOptions {
  readonly url?: string
}

export interface RedisBrokerClient {
  connect(): Promise<void>
  close(): void
  exists(key: string): Promise<boolean>
  hmget(key: string, fields: string[]): Promise<Array<string | null>>
  send(command: string, args: string[]): Promise<unknown>
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
  private connectPromise: Promise<RedisBrokerClient> | undefined
  private client: RedisBrokerClient | undefined
  private commandQueue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    options: RedisBrokerConnectionOptions = {},
    private readonly clientFactory: RedisBrokerClientFactory = createRedisBrokerClient
  ) {
    const { url, ...redisOptions } = options
    this.url = url
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
  async useCommandClient<T>(operation: (client: RedisBrokerClient) => Promise<T>): Promise<T> {
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
      return await operation(client)
    } finally {
      release()
    }
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

function redisUrlFromEnvironment(): string | undefined {
  return process.env["REDIS_URL"] || process.env["VALKEY_URL"]
}
