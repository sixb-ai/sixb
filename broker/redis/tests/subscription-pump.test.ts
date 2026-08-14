import { expect, spyOn, test } from "bun:test"
import type { RedisBrokerClient } from "../src/connection"
import { encodeRecord } from "../src/serialization"
import type { EnsuredStream } from "../src/stream-manager"
import { RedisSubscriptionPump, type RedisSubscriptionPumpOptions } from "../src/subscription-pump"

const stream: EnsuredStream = {
  projectId: "project",
  streamId: "stream",
  keys: {
    streamKey: "stream-key",
    metaKey: "meta-key",
    dedupeKey: (idempotencyKey) => `dedupe:${idempotencyKey ?? "_"}`,
  },
}

test("replaces a client when the XREAD watchdog expires", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined)
  const closedClients = new Set<RedisBrokerClient>()
  const initialClient = fakeClient(() => new Promise<unknown>(() => undefined))
  let replacementReadCount = 0
  const replacementClient = fakeClient(async () => {
    replacementReadCount += 1
    if (replacementReadCount === 1) {
      return [
        [
          stream.keys.streamKey,
          [
            [
              "1-0",
              ["body", encodeRecord({ payload: "after-watchdog" }, "2026-08-14T00:00:00.000Z")],
            ],
          ],
        ],
      ]
    }
    return new Promise<unknown>(() => undefined)
  })
  let replacementCount = 0
  const connectionManager: RedisSubscriptionPumpOptions["connectionManager"] = {
    createSubscriptionClient: async () => {
      replacementCount += 1
      return replacementClient
    },
    closeClient: (client) => {
      closedClients.add(client)
    },
  }
  const received: unknown[] = []
  const pump = new RedisSubscriptionPump({
    connectionManager,
    client: initialClient,
    stream,
    batchSize: 1,
    blockMs: 1,
    handler: (records) => received.push(...records.map((record) => record.payload)),
  })

  try {
    pump.start("0-0")
    await waitUntil(() => received.length === 1, 2_500)

    expect(received).toEqual(["after-watchdog"])
    expect(replacementCount).toBe(1)
    expect(closedClients.has(initialClient)).toBe(true)
    expect(
      errors.mock.calls.some((args) => args.some((arg) => String(arg).includes("did not finish")))
    ).toBe(true)
  } finally {
    pump.stop()
    try {
      await withTimeout(pump.drain(), 250)
    } finally {
      errors.mockRestore()
    }
  }
})

test("drains promptly when stopped during a pending reconnect", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined)
  const initialClient = fakeClient(async () => {
    throw new Error("connection lost")
  })
  let notifyReconnect!: (signal: AbortSignal | undefined) => void
  const reconnectStarted = new Promise<AbortSignal | undefined>((resolve) => {
    notifyReconnect = resolve
  })
  const connectionManager: RedisSubscriptionPumpOptions["connectionManager"] = {
    createSubscriptionClient: (signal) => {
      notifyReconnect(signal)
      return new Promise<RedisBrokerClient>((_resolve, reject) => {
        if (signal === undefined) return
        const onAbort = () => reject(new Error("connection aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    },
    closeClient: () => undefined,
  }
  const pump = new RedisSubscriptionPump({
    connectionManager,
    client: initialClient,
    stream,
    batchSize: 1,
    blockMs: 1,
    handler: () => undefined,
  })

  try {
    pump.start("0-0")
    const signal = await withTimeout(reconnectStarted, 500)
    expect(signal).toBeDefined()

    pump.stop()
    await withTimeout(pump.drain(), 250)
  } finally {
    pump.stop()
    errors.mockRestore()
  }
})

function fakeClient(send: RedisBrokerClient["send"]): RedisBrokerClient {
  return {
    connect: async () => undefined,
    close: () => undefined,
    exists: async () => false,
    hmget: async () => [],
    send,
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
