import { expect, test } from "bun:test"
import { type RedisBrokerClient, RedisConnectionManager } from "../src/connection"
import { RedisBrokerError } from "../src/errors"
import { streamKeysFor } from "../src/keys"
import { RedisBroker } from "../src/redis-broker"
import type { EnsuredStream, StreamManager } from "../src/stream-manager"

test("aborts a pending subscription client connection", async () => {
  let closeCount = 0
  let receivedOptions: object | undefined
  const client = fakeClient({
    connect: () => new Promise<void>(() => undefined),
    close: () => {
      closeCount += 1
    },
  })
  const manager = new RedisConnectionManager(
    {
      url: "redis://unused",
      autoReconnect: true,
      enableOfflineQueue: true,
    },
    (_url, options) => {
      receivedOptions = options
      return client
    }
  )
  const controller = new AbortController()

  const outcome = manager.createSubscriptionClient(controller.signal).then(
    () => undefined,
    (error: unknown) => error
  )
  await Promise.resolve()
  controller.abort()

  const error = await outcome
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected subscription connection to fail")
  expect(error.message).toContain("Failed to connect Redis subscription client")
  expect(closeCount).toBe(1)
  expect(receivedOptions).toMatchObject({
    autoReconnect: false,
    enableOfflineQueue: false,
  })
})

test("closing the manager aborts a subscription client that is still connecting", async () => {
  let closeCount = 0
  const client = fakeClient({
    connect: () => new Promise<void>(() => undefined),
    close: () => {
      closeCount += 1
    },
  })
  const manager = new RedisConnectionManager({}, () => client)

  const outcome = manager.createSubscriptionClient().then(
    () => undefined,
    (error: unknown) => error
  )
  await Promise.resolve()
  await manager.close()

  const error = await outcome
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected subscription connection to fail")
  expect(error.message).toContain("Failed to connect Redis subscription client")
  expect(closeCount).toBe(1)
})

function fakeClient(overrides: {
  readonly connect?: () => Promise<void>
  readonly close?: () => void
  readonly exists?: RedisBrokerClient["exists"]
  readonly hmget?: RedisBrokerClient["hmget"]
  readonly send?: RedisBrokerClient["send"]
}): RedisBrokerClient {
  return {
    connect: overrides.connect ?? (async () => undefined),
    close: overrides.close ?? (() => undefined),
    exists: overrides.exists ?? (async () => false),
    hmget: overrides.hmget ?? (async () => []),
    send: overrides.send ?? (async () => null),
  }
}

/** A command that is sent and never answered, like the append reported in #217. */
function neverResponds(): Promise<never> {
  return new Promise<never>(() => undefined)
}

function settle<T>(promise: Promise<T>): Promise<T | unknown> {
  return promise.then(
    (value) => value,
    (error: unknown) => error
  )
}

// The tests below guard the fix for #217. To prove they still guard it, drop the
// `boundedCommandClient(client)` wrapper in `useCommandClient` and pass `client` directly. All
// four timeout tests then hang until bun's per-test timeout, because without a bound nothing ever
// settles them -- including the first, which never reaches its assertion.

test("a command that is never answered fails once the bound elapses", async () => {
  const manager = new RedisConnectionManager({ url: "redis://unused", commandTimeoutMs: 25 }, () =>
    fakeClient({ send: neverResponds })
  )

  const error = await settle(manager.useCommandClient((client) => client.send("EVAL", [])))

  expect(error).toBeInstanceOf(RedisBrokerError)
  if (!(error instanceof Error)) throw new Error("Expected the command to fail")
  expect(error.message).toContain("command EVAL did not respond within 25ms")

  await manager.close()
})

test("an unanswered command does not block later commands", async () => {
  // #217: one unanswered append held the shared command queue and stopped all event publication.
  let clientCount = 0
  const manager = new RedisConnectionManager(
    { url: "redis://unused", commandTimeoutMs: 25 },
    () => {
      clientCount += 1
      const wedges = clientCount === 1
      return fakeClient({ send: wedges ? neverResponds : async () => "PONG" })
    }
  )

  const wedged = settle(manager.useCommandClient((client) => client.send("EVAL", [])))
  const next = manager.useCommandClient((client) => client.send("PING", []))

  expect(await wedged).toBeInstanceOf(RedisBrokerError)
  expect(await next).toBe("PONG")

  await manager.close()
})

test("a timed-out client is closed and replaced for the next command", async () => {
  // A missing reply may still arrive, so the connection cannot be reused for another command.
  let clientCount = 0
  let closeCount = 0
  const manager = new RedisConnectionManager(
    { url: "redis://unused", commandTimeoutMs: 25 },
    () => {
      clientCount += 1
      const wedges = clientCount === 1
      return fakeClient({
        send: wedges ? neverResponds : async () => "PONG",
        close: () => {
          closeCount += 1
        },
      })
    }
  )

  await settle(manager.useCommandClient((client) => client.send("EVAL", [])))
  expect(closeCount).toBe(1)

  expect(await manager.useCommandClient((client) => client.send("PING", []))).toBe("PONG")
  expect(clientCount).toBe(2)

  await manager.close()
})

test("closing completes while a command is still unanswered", async () => {
  // `close()` awaits the same queue, so an unbounded command also blocked shutdown.
  let markSent: () => void = () => undefined
  const sent = new Promise<void>((resolve) => {
    markSent = resolve
  })
  const manager = new RedisConnectionManager({ url: "redis://unused", commandTimeoutMs: 25 }, () =>
    fakeClient({
      send: () => {
        markSent()
        return neverResponds()
      },
    })
  )

  const wedged = settle(manager.useCommandClient((client) => client.send("EVAL", [])))
  // Close only once the command is genuinely in flight. Closing earlier aborts it through
  // `assertOpen()` instead, which releases the queue on its own and guards nothing.
  await sent
  await manager.close()

  expect(await wedged).toBeInstanceOf(RedisBrokerError)
})

test("the command bound is ours and never reaches the Redis client", async () => {
  let receivedOptions: object | undefined
  const manager = new RedisConnectionManager(
    { url: "redis://unused", commandTimeoutMs: 25, idleTimeout: 3 },
    (_url, options) => {
      receivedOptions = options
      return fakeClient({ send: async () => "PONG" })
    }
  )

  expect(await manager.useCommandClient((client) => client.send("PING", []))).toBe("PONG")
  expect(receivedOptions).toEqual({ idleTimeout: 3 })

  await manager.close()
})

test("each command in one operation gets its own timeout", async () => {
  // To prove this guards command-level granularity, also race the complete operation against
  // `commandTimeoutMs` in `useCommandClient`; the second command then fails this test.
  let callCount = 0
  const manager = new RedisConnectionManager({ url: "redis://unused", commandTimeoutMs: 30 }, () =>
    fakeClient({
      send: async () => {
        callCount += 1
        const call = callCount
        await Bun.sleep(20)
        return `reply-${call}`
      },
    })
  )

  const replies = await manager.useCommandClient(async (client) => {
    const first = await client.send("ONE", [])
    const second = await client.send("TWO", [])
    return [first, second]
  })

  expect(replies).toEqual(["reply-1", "reply-2"])
  await manager.close()
})

test("rejects a command bound that setTimeout cannot represent", () => {
  // Bun coerces NaN, non-positive values, and delays above a signed 32-bit integer to 1ms.
  for (const commandTimeoutMs of [Number.NaN, 0, -1, 0.5, 2_147_483_648]) {
    expect(() => new RedisBroker({ connection: { commandTimeoutMs } })).toThrow(RedisBrokerError)
  }

  expect(() => new RedisBroker({ connection: { commandTimeoutMs: 25 } })).not.toThrow()
})

test("keeps the caller-owned dedupe window independent from the command timeout", () => {
  // Reintroducing a constructor check between these values fails this test while still being
  // unable to account for later commands or the caller's retry delay.
  expect(
    () => new RedisBroker({ connection: { commandTimeoutMs: 25 }, dedupeTtlMs: 1 })
  ).not.toThrow()
})

test("bounds the latest-cursor lookup on the subscription client", async () => {
  // To prove this guards the bootstrap path, pass the raw subscription client to
  // `subscriptionStartCursor` again. Its XREVRANGE then hangs until this test's own timeout.
  const ensured: EnsuredStream = {
    projectId: "project",
    streamId: "events",
    keys: streamKeysFor("sixb:broker", "project", "events"),
  }
  let clientCount = 0
  const manager = new RedisConnectionManager(
    { url: "redis://unused", commandTimeoutMs: 25 },
    () => {
      clientCount += 1
      return fakeClient({
        hmget: async () => [null],
        send: (command) => (command === "XREVRANGE" ? neverResponds() : Promise.resolve(null)),
      })
    }
  )
  const broker = new RedisBroker({ connection: { commandTimeoutMs: 25 } })
  const internals = broker as unknown as {
    connectionManager: RedisConnectionManager
    streamManager: Pick<StreamManager, "readMetadata" | "requireStream">
  }
  internals.connectionManager = manager
  internals.streamManager = {
    readMetadata: async () => new Map(),
    requireStream: async () => ensured,
  }

  const error = await settle(
    broker.subscribe({ projectId: "project", streamId: "events" }, () => undefined)
  )

  expect(error).toBeInstanceOf(RedisBrokerError)
  expect(clientCount).toBe(2)
  await broker.close()
}, 250)
