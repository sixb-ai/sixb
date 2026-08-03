import { SixbError } from "@sixb/core/errors"
import IORedis, { type Redis, type RedisOptions } from "ioredis"

export type BullMqConnectionInput = string | RedisOptions | Redis

export interface BullMqConnections {
  /** Connection used by `Queue` handles (non-blocking operations). */
  readonly queueConnection: Redis
  /** Connection used by `Worker` handles (blocking fetch loop). */
  readonly workerConnection: Redis
  /** Closes only connections this provider owns; borrowed connections are left intact. */
  close(): Promise<void>
}

function isRedisClient(value: BullMqConnectionInput): value is Redis {
  return typeof value === "object" && value !== null && typeof (value as Redis).quit === "function"
}

/**
 * Builds the IORedis handles BullMQ requires.
 *
 * Owning the IORedis instances (rather than letting BullMQ create them from `RedisOptions`)
 * lets us attach `noop` error listeners. Without them, "Connection is closed" events emitted
 * by the raw socket at shutdown propagate as unhandled rejections under stricter runtimes
 * (e.g. Bun >= 1.3.13), failing adjacent tests. BullMQ forwards some connection errors to its
 * own `Queue`/`Worker` EventEmitters, but not all — the socket-level close race slips through.
 *
 * - `Queue` handles may share a connection with any settings.
 * - `Worker` handles require `maxRetriesPerRequest: null` because BullMQ uses blocking Redis
 *   commands in the fetch loop.
 *
 * When given an existing IORedis client, it is borrowed for both roles and must already be
 * configured with `maxRetriesPerRequest: null`.
 */
export function resolveConnections(input: BullMqConnectionInput): BullMqConnections {
  if (isRedisClient(input)) {
    const options = input.options as RedisOptions | undefined
    if (options && options.maxRetriesPerRequest !== null) {
      throw new SixbError(
        "runtime.invalid_input",
        "[Sixb] BullMqQueues requires a borrowed IORedis connection with `maxRetriesPerRequest: null`"
      )
    }
    return {
      queueConnection: input,
      workerConnection: input,
      async close() {},
    }
  }

  const build = (extra: RedisOptions = {}): Redis =>
    typeof input === "string" ? new IORedis(input, extra) : new IORedis({ ...input, ...extra })

  const queueConnection = build()
  const workerConnection = build({ maxRetriesPerRequest: null })

  // BullMQ's `Worker.close()` cancels its internal timers, but Redis commands that are already
  // in flight when the connection is quit can emit "Connection is closed" as an unhandled
  // `error` event on the ioredis instance. Those are benign shutdown races — ioredis already
  // rejects the command-level promise — so we attach a no-op listener to keep the test runner
  // from failing the next test with an async rejection.
  queueConnection.on("error", noop)
  workerConnection.on("error", noop)

  return {
    queueConnection,
    workerConnection,
    async close() {
      await Promise.all([
        queueConnection.quit().catch(() => undefined),
        workerConnection.quit().catch(() => undefined),
      ])
    },
  }
}

function noop(): void {}
