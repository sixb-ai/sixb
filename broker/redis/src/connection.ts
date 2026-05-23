import { createClient, type RedisClientOptions } from "redis"
import { RedisBrokerError } from "./errors"

export type RedisBrokerClient = ReturnType<typeof createClient>

/**
 * Lazily manages Redis clients for the broker.
 *
 * The main client handles ordinary commands. Blocking `XREAD` subscriptions get
 * dedicated clients so a blocked subscription cannot starve append/read calls.
 */
export class RedisConnectionManager {
  private readonly options: RedisClientOptions
  private connectPromise: Promise<RedisBrokerClient> | undefined
  private client: RedisBrokerClient | undefined

  constructor(options: RedisClientOptions) {
    this.options = options
  }

  async connect(): Promise<RedisBrokerClient> {
    if (this.client?.isOpen) {
      return this.client
    }
    if (this.connectPromise !== undefined) {
      return this.connectPromise
    }

    this.connectPromise = this.openClient("Failed to connect to Redis").then((client) => {
      this.client = client
      return client
    })

    try {
      return await this.connectPromise
    } catch (error) {
      this.connectPromise = undefined
      throw error
    }
  }

  async createSubscriptionClient(): Promise<RedisBrokerClient> {
    return this.openClient("Failed to connect Redis subscription client")
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.connectPromise = undefined
    if (client === undefined || !client.isOpen) {
      return
    }
    await client.close().catch(() => undefined)
  }

  destroyClient(client: RedisBrokerClient): void {
    if (!client.isOpen) {
      return
    }
    client.destroy()
  }

  private async openClient(errorMessage: string): Promise<RedisBrokerClient> {
    const client = createClient(this.options)
    client.on("error", noop)
    try {
      await client.connect()
      return client
    } catch (error) {
      client.destroy()
      throw new RedisBrokerError(errorMessage, { cause: error })
    }
  }
}

function noop(): void {}
