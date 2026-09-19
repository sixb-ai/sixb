import { expect, test } from "bun:test"
import {
  type RedisBrokerClient,
  type RedisBrokerCommandClient,
  RedisConnectionManager,
} from "../src/connection"
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

function failedConnection(): Error {
  return Object.assign(new Error("Connection has failed"), {
    name: "RedisError",
    code: "ERR_REDIS_CONNECTION_CLOSED",
  })
}

// Regression proof: restore connection.ts from 3a9a076c and run this file. Recovery cases
// fail on Bun 1.4.2; connection-recovery.e2e.ts exercises the same failure with native clients.
for (const method of ["exists", "hmget", "send"] as const) {
  for (const synchronous of [false, true]) {
    test(`replaces a terminal client for ${method} (${synchronous ? "throw" : "rejection"})`, async () => {
      let created = 0
      let closed = 0
      let rejectedCalls = 0
      const failed = fakeClient({
        [method]: () => {
          rejectedCalls++
          if (synchronous) throw failedConnection()
          return Promise.reject(failedConnection())
        },
        close: () => closed++,
      })
      const healthy = fakeClient({
        exists: async () => true,
        hmget: async () => ["value"],
        send: async () => "PONG",
      })
      const manager = new RedisConnectionManager({}, () => (++created === 1 ? failed : healthy))
      try {
        const call = (client: RedisBrokerCommandClient) => {
          if (method === "exists") return client.exists("key")
          if (method === "hmget") return client.hmget("key", ["field"])
          return client.send("PING", [])
        }
        const expected = method === "exists" ? true : method === "hmget" ? ["value"] : "PONG"
        // Calls queued behind the failed command must share the replacement.
        expect(
          await Promise.all([manager.useCommandClient(call), manager.useCommandClient(call)])
        ).toEqual([expected, expected])
        expect(created).toBe(2)
        expect(closed).toBe(1)
        expect(rejectedCalls).toBe(1)
      } finally {
        await manager.close()
      }
    })
  }
}

test("retries only the unsent command and keeps its replacement for the rest of the operation", async () => {
  const commands: string[] = []
  let created = 0
  const first = fakeClient({
    send: async (command) => {
      commands.push(`first:${command}`)
      if (command === "SECOND") throw failedConnection()
      return "OK"
    },
  })
  const second = fakeClient({
    send: async (command) => {
      commands.push(`second:${command}`)
      return "OK"
    },
  })
  const manager = new RedisConnectionManager({}, () => (++created === 1 ? first : second))
  try {
    await manager.useCommandClient(async (client) => {
      await client.send("FIRST", [])
      await client.send("SECOND", [])
      await client.send("THIRD", [])
    })
    expect(commands).toEqual(["first:FIRST", "first:SECOND", "second:SECOND", "second:THIRD"])
    expect(created).toBe(2)
  } finally {
    await manager.close()
  }
})

test("bounds terminal recovery to one retry and discards a failed replacement", async () => {
  let created = 0
  let closed = 0
  const manager = new RedisConnectionManager({}, () => {
    created++
    return fakeClient({
      send: async () => {
        throw failedConnection()
      },
      close: () => closed++,
    })
  })
  try {
    await expect(manager.useCommandClient((client) => client.send("PING", []))).rejects.toThrow(
      "Connection has failed"
    )
    expect(created).toBe(2)
    expect(closed).toBe(2)
    await expect(manager.useCommandClient((client) => client.send("PING", []))).rejects.toThrow(
      "Connection has failed"
    )
    expect(created).toBe(4)
  } finally {
    await manager.close()
  }
})

for (const error of [
  Object.assign(new Error("Connection closed"), {
    name: "RedisError",
    code: "ERR_REDIS_CONNECTION_CLOSED",
  }),
  Object.assign(new Error("Connection timeout"), {
    name: "RedisError",
    code: "ERR_REDIS_CONNECTION_TIMEOUT",
  }),
  Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), {
    name: "RedisError",
  }),
  new Error("Connection has failed"),
]) {
  test(`does not replay a command with an uncertain or server failure: ${error.message}`, async () => {
    let created = 0
    let calls = 0
    const manager = new RedisConnectionManager({}, () => {
      created++
      return fakeClient({
        send: async () => {
          calls++
          throw error
        },
      })
    })
    try {
      await expect(
        manager.useCommandClient((client) => client.send("INCR", ["counter"]))
      ).rejects.toBe(error)
      expect(calls).toBe(1)
      expect(created).toBe(1)
    } finally {
      await manager.close()
    }
  })
}

test("shutdown aborts a pending replacement connection", async () => {
  let created = 0
  let closed = 0
  const connecting = Promise.withResolvers<void>()
  const manager = new RedisConnectionManager({}, () => {
    created++
    return fakeClient(
      created === 1
        ? {
            send: async () => {
              throw failedConnection()
            },
            close: () => closed++,
          }
        : {
            connect: () => {
              connecting.resolve()
              return neverResponds()
            },
            close: () => closed++,
          }
    )
  })
  const result = settle(manager.useCommandClient((client) => client.send("PING", [])))
  try {
    await connecting.promise
    await manager.close()
    expect(await result).toBeInstanceOf(RedisBrokerError)
    expect(created).toBe(2)
    expect(closed).toBe(2)
  } finally {
    await manager.close()
  }
})

test("subscription commands leave terminal recovery to their pump", async () => {
  let created = 0
  let closed = 0
  const error = failedConnection()
  const manager = new RedisConnectionManager({}, () => {
    created++
    return fakeClient({
      send: async () => {
        throw error
      },
      close: () => closed++,
    })
  })
  const subscription = await manager.createSubscriptionClient()
  try {
    await expect(
      manager.boundedCommandClient(subscription).send("XREVRANGE", ["stream", "+", "-"])
    ).rejects.toBe(error)
    expect(created).toBe(1)
    expect(closed).toBe(0)
  } finally {
    manager.closeClient(subscription)
    await manager.close()
  }
})

test("a failed replacement connect surfaces and leaves the next operation able to reconnect", async () => {
  let created = 0
  let closed = 0
  const manager = new RedisConnectionManager({}, () => {
    created++
    return fakeClient({
      ...(created === 1
        ? {
            send: async () => {
              throw failedConnection()
            },
          }
        : created === 2
          ? {
              connect: async () => {
                throw new Error("Redis is still offline")
              },
            }
          : { send: async () => "PONG" }),
      close: () => closed++,
    })
  })
  try {
    const error = await settle(manager.useCommandClient((client) => client.send("PING", [])))
    expect(error).toBeInstanceOf(RedisBrokerError)
    expect((error as Error).cause).toEqual(new Error("Redis is still offline"))
    expect(created).toBe(2)
    expect(closed).toBe(2)
    expect(await manager.useCommandClient((client) => client.send("PING", []))).toBe("PONG")
    expect(created).toBe(3)
  } finally {
    await manager.close()
  }
})
