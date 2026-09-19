import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import net from "node:net"
import { RedisClient } from "bun"
import { RedisBroker } from "../src"
import { requireRedisUrl } from "./helpers"

// Bun 1.4.2 retains a terminal client after exhausting reconnects while idle. Restore
// connection.ts from 3a9a076c: the first post-outage append fails with "Connection has failed".
// A short retry budget makes this deterministic without a minute-long outage in CI. The default
// retry budget was also reproduced with a 60s outage against Valkey 8.1.9 over TLS on Bun 1.4.2.
test("an existing broker resumes event and log writes after exhausting idle reconnects", async () => {
  const upstream = new URL(requireRedisUrl())
  const sockets = new Set<net.Socket>()
  const proxy = net.createServer((incoming) => {
    const outgoing = net.connect({ host: upstream.hostname, port: Number(upstream.port) })
    sockets.add(incoming)
    sockets.add(outgoing)
    incoming.on("error", () => outgoing.destroy())
    outgoing.on("error", () => incoming.destroy())
    incoming.on("close", () => {
      sockets.delete(incoming)
      outgoing.destroy()
    })
    outgoing.on("close", () => {
      sockets.delete(outgoing)
      incoming.destroy()
    })
    incoming.pipe(outgoing)
    outgoing.pipe(incoming)
  })
  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      proxy.once("error", onError)
      proxy.listen(port, "127.0.0.1", () => {
        proxy.off("error", onError)
        resolve()
      })
    })
  const cut = async () => {
    for (const socket of sockets) socket.destroy()
    if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()))
  }
  await listen(0)
  const address = proxy.address()
  if (address === null || typeof address === "string") throw new Error("Missing proxy port")
  const url = `redis://127.0.0.1:${address.port}`
  const projectId = randomUUID()
  const broker = new RedisBroker({ connection: { url, maxRetries: 1 } })
  const probe = new RedisClient(url, { autoReconnect: false })
  try {
    for (const streamId of ["__events", "__logs"]) {
      await broker.ensureStream({ projectId, stream: { id: streamId } })
      await broker.append({ projectId, streamId, records: [{ payload: "before" }] })
    }
    await cut()
    // No broker commands during the outage, matching an idle hourly worker. With one retry,
    // native reconnection is exhausted well inside this one-second bound.
    await Bun.sleep(1_000)
    await listen(address.port)
    await probe.connect()
    expect(await probe.send("PING", [])).toBe("PONG")
    for (let n = 0; n < 3; n++) {
      for (const streamId of ["__events", "__logs"]) {
        await broker.append({ projectId, streamId, records: [{ payload: `after-${n}` }] })
      }
    }
    for (const streamId of ["__events", "__logs"]) {
      const { records } = await broker.read({ projectId, streamId })
      // No idempotency keys: replaying successful writes would create visible duplicates.
      expect(records.map((record) => record.payload)).toEqual([
        "before",
        "after-0",
        "after-1",
        "after-2",
      ])
    }
  } finally {
    await broker.close()
    probe.close()
    await cut()
  }
}, 15_000)
