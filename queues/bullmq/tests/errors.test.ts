import { afterEach, describe, expect, test } from "bun:test"
import { SixbError } from "@sixb/core/errors"
import IORedis from "ioredis"
import { BullMqQueues } from "../src"

/**
 * These cases need a Redis that is *not* there, so they run in the fast suite rather than in
 * `queues-bullmq.e2e.ts`: no container, no `SIXB_REDIS_URL`, nothing to wait for.
 *
 * Port 1 is never listening. `enableOfflineQueue: false` makes every command reject the moment the
 * socket is not writable instead of buffering it, and a `retryStrategy` returning `null` stops
 * ioredis from reconnecting — so each call fails once, immediately, with a real driver error.
 */
function createUnreachableConnection(): IORedis {
  const connection = new IORedis({
    host: "127.0.0.1",
    port: 1,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  })
  connection.on("error", () => undefined)
  return connection
}

const opened: { provider: BullMqQueues; connection: IORedis }[] = []

function createUnreachableProvider(): BullMqQueues {
  const connection = createUnreachableConnection()
  const provider = new BullMqQueues({ connection, prefix: "sixb-unreachable" })
  opened.push({ provider, connection })
  return provider
}

afterEach(async () => {
  const handles = opened.splice(0)
  for (const { provider, connection } of handles) {
    await provider.close()
    connection.disconnect()
  }
})

/**
 * To check these have teeth, drop the `try/catch` around the driver call in the matching method of
 * `src/bullmq-queue.ts`: the raw ioredis error escapes, `error.code` is `undefined`, and every
 * assertion below fails. That raw error is the bug — downstream it was filed as `action.failed` on
 * the run row and answered `400`, because the route's fallback for an unrecognized throw is
 * `runtime.invalid_input`.
 */
describe("BullMqQueues driver failures", () => {
  test("enqueue raises queue.unavailable when Redis is unreachable", async () => {
    const provider = createUnreachableProvider()

    const error = await provider.syncRuns
      .enqueue({
        projectId: "project-a",
        jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
      })
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(SixbError)
    const sixbError = error as SixbError
    expect(sixbError.code).toBe("queue.unavailable")
    // 503 and worth another attempt: the queue refused the work, the caller did nothing wrong.
    expect(sixbError.retryable).toBe(true)
    expect(sixbError.details).toEqual({ provider: "@sixb/queues-bullmq", operation: "enqueue" })
    // The driver's own error is what says *why* Redis was unreachable; wrapping must not lose it.
    expect(sixbError.cause).toBeInstanceOf(Error)
  })

  test("claim raises queue.unavailable when Redis is unreachable", async () => {
    const provider = createUnreachableProvider()

    const error = await provider.syncRuns
      .claim({ projectId: "project-a", workerId: "worker-1" })
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(SixbError)
    expect((error as SixbError).code).toBe("queue.unavailable")
    expect((error as SixbError).cause).toBeInstanceOf(Error)
  })

  test("renewLease raises queue.unavailable when Redis is unreachable", async () => {
    const provider = createUnreachableProvider()

    const error = await provider.syncRuns
      .renewLease({ projectId: "project-a", jobId: "job-1", leaseId: "lease-1", leaseMs: 1_000 })
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(SixbError)
    expect((error as SixbError).code).toBe("queue.unavailable")
    expect((error as SixbError).cause).toBeInstanceOf(Error)
  })

  test("complete raises queue.unavailable rather than reporting an unknown job", async () => {
    const provider = createUnreachableProvider()

    const error = await provider.syncRuns
      .complete({ projectId: "project-a", jobId: "job-1", leaseId: "lease-1" })
      .catch((thrown: unknown) => thrown)

    // The job lookup that precedes the lease move goes through the same driver. Left raw it fell
    // through to "unknown queue job", which blames the caller for an outage.
    expect(error).toBeInstanceOf(SixbError)
    expect((error as SixbError).code).toBe("queue.unavailable")
  })

  test("keeps the code this adapter already assigned", async () => {
    const provider = createUnreachableProvider()
    await provider.close()

    const error = await provider.syncRuns
      .enqueue({
        projectId: "project-a",
        jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
      })
      .catch((thrown: unknown) => thrown)

    // A closed provider is the caller's mistake, not the queue's. Normalizing must not overwrite it.
    expect((error as SixbError).code).toBe("runtime.invalid_input")
  })
})
