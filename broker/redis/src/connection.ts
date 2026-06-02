import { RedisClient, type RedisOptions } from "bun"
import { RedisBrokerError } from "./errors"

export interface RedisBrokerConnectionOptions extends RedisOptions {
  readonly url?: string
}

export type RedisBrokerClient = RedisClient

/**
 * Lazily manages Redis clients for the broker.
 *
 * The main client handles ordinary commands. Blocking `XREAD` subscriptions get
 * dedicated clients so a blocked subscription cannot starve append/read calls.
 */
export class RedisConnectionManager {
  private readonly url: string | undefined
  private readonly options: RedisOptions | undefined
  private connectPromise: Promise<RedisBrokerClient> | undefined
  private client: RedisBrokerClient | undefined
  private commandQueue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(options: RedisBrokerConnectionOptions = {}) {
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

  async createSubscriptionClient(): Promise<RedisBrokerClient> {
    this.assertOpen()
    const client = await this.openClient("Failed to connect Redis subscription client")
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

  private async openClient(errorMessage: string): Promise<RedisBrokerClient> {
    const client = new RedisClient(this.url ?? redisUrlFromEnvironment(), this.options)
    try {
      await client.connect()
      return client
    } catch (error) {
      this.closeClient(client)
      throw new RedisBrokerError(errorMessage, { cause: error })
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
