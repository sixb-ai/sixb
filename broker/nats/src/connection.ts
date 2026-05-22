import type { ConnectionOptions, NatsConnection } from "@nats-io/nats-core"
import { connect } from "@nats-io/transport-node"
import { NatsBrokerError } from "./errors"

/**
 * Lazily manages a single NATS connection.
 *
 * The constructor is synchronous per the public NatsBroker contract. The
 * actual NATS connection is established on first use. Concurrent first
 * callers share the same in-flight connect Promise to avoid opening multiple
 * connections in parallel.
 *
 * On connection failure, the cached Promise is cleared so a subsequent call
 * can retry. This prevents the manager from being stuck with a permanently
 * rejected Promise after a transient startup error.
 *
 * Post-initial reconnection is handled transparently by the NATS client's
 * built-in reconnect logic and is intentionally NOT wrapped here.
 */
export class NatsConnectionManager {
  private readonly options: ConnectionOptions
  private connectPromise: Promise<NatsConnection> | undefined
  private connection: NatsConnection | undefined

  constructor(options: ConnectionOptions) {
    this.options = options
  }

  /**
   * Returns the live NATS connection, initiating the connect call on first
   * use. Safe to call concurrently.
   */
  async connect(): Promise<NatsConnection> {
    if (this.connection !== undefined) {
      return this.connection
    }
    if (this.connectPromise !== undefined) {
      return this.connectPromise
    }

    this.connectPromise = (async () => {
      try {
        const nc = await connect(this.options)
        this.connection = nc
        return nc
      } catch (error) {
        // Clear so the next caller can retry from scratch.
        this.connectPromise = undefined
        throw new NatsBrokerError("Failed to connect to NATS", { cause: error })
      }
    })()

    return this.connectPromise
  }

  /**
   * Returns true if a connection has been established and not yet closed.
   */
  isConnected(): boolean {
    return this.connection !== undefined
  }

  /**
   * Drains and closes the NATS connection. Safe to call if never connected.
   */
  async close(): Promise<void> {
    const nc = this.connection
    this.connection = undefined
    this.connectPromise = undefined
    if (nc === undefined) {
      return
    }
    // drain() flushes pending messages before closing. Prefer over close()
    // so any publishes in flight are actually sent before teardown.
    await nc.drain()
  }
}
