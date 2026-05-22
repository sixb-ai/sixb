import { randomUUID } from "node:crypto"
import IORedis from "ioredis"
import { BullMqQueues, type BullMqQueuesOptions } from "../src"

/**
 * Reads `PARIO_REDIS_URL` (set by `tests/setup.ts` after `docker compose up`). Throws if the
 * setup hook did not run, which is the early signal that `bun run test:e2e` was not used.
 */
export function requireRedisUrl(): string {
  const url = process.env["PARIO_REDIS_URL"]
  if (!url) {
    throw new Error(
      "[BullMqQueues test] PARIO_REDIS_URL is required. Run `bun run test:e2e` from the @pario/queues-bullmq package."
    )
  }
  return url
}

let sharedConnection: IORedis | undefined

/**
 * Returns a module-level IORedis client lazily initialized on first use, reused by every
 * `createTestQueues()` call in the suite.
 *
 * Why shared: BullMQ's official guidance (and practical observation on Bun ≥ 1.3.13) is to
 * create/close connections at the suite level — not per test. Each `new BullMqQueues` + close()
 * pair opens and quits real sockets; the socket-close path inside ioredis rejects any in-flight
 * command via `flushQueue(new Error("Connection is closed"))`, and those rejections escape
 * BullMQ's `checkConnectionError` catch in rare but real timing windows, landing as unhandled
 * rejections that flake adjacent test cases. Passing this client as `connection` puts the
 * provider in borrowed mode (`BullMqQueues.close()` never quits it), so per-test teardown
 * becomes a pure no-op on the socket and the race disappears. The socket is quit exactly once,
 * after all tests have run, via `closeSharedConnection()`.
 */
function getSharedConnection(): IORedis {
  if (!sharedConnection) {
    sharedConnection = new IORedis(requireRedisUrl(), { maxRetriesPerRequest: null })
    sharedConnection.on("error", () => undefined)
  }
  return sharedConnection
}

/** Quits the suite-level shared connection. Call from `afterAll`. Safe to call multiple times. */
export async function closeSharedConnection(): Promise<void> {
  if (!sharedConnection) return
  const connection = sharedConnection
  sharedConnection = undefined
  await connection.quit().catch(() => undefined)
}

/**
 * Builds a `BullMqQueues` provider bound to a shared borrowed IORedis and a unique prefix.
 *
 * Per-test prefixes keep Redis keys isolated, so parallel tests inside a single suite — and
 * reruns of the same suite — cannot observe each other's state. Timing options default to
 * values tuned for fast e2e runs (small lease windows, frequent stalled checks).
 */
export function createTestQueues(overrides: Partial<BullMqQueuesOptions> = {}): BullMqQueues {
  return new BullMqQueues({
    connection: getSharedConnection(),
    prefix: `pario-test-${randomUUID().slice(0, 8)}`,
    defaultLeaseMs: 150,
    stalledInterval: 50,
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
    ...overrides,
  })
}

/** Builds a dedicated borrowed IORedis client for tests that need their own connection. */
export function createBorrowedConnection(): IORedis {
  return new IORedis(requireRedisUrl(), { maxRetriesPerRequest: null })
}

const SHARED_PROVIDER_PREFIX = "pario-contract-suite"

let sharedProvider: BullMqQueues | undefined

/**
 * Returns a suite-level shared `BullMqQueues` for the contract tests. The same provider is
 * reused across every contract test case — state is reset between tests via `flushSharedRedis`.
 *
 * Why: BullMQ's own guidance (issue #2686 and related) is that creating and destroying Worker
 * instances per test races with their internal blocking-connection cleanup. Even when the
 * outer ioredis is shared, `Worker.close()` closes the duplicated blocking connection BullMQ
 * opened for `BRPOPLPUSH`, and the `flushQueue(new Error("Connection is closed"))` path on
 * that duplicate surfaces as an unhandled rejection in adjacent tests on Bun ≥ 1.3.13. Keeping
 * one provider for the whole suite eliminates the per-test open/close race at the source.
 *
 * Redis key isolation for tests that collide on `projectId` ("project-a", "project-b") is
 * handled by `flushSharedRedis()` — called in the suite's per-test `teardown` — which wipes
 * the dedicated test Redis before the next case runs.
 */
export function getSharedProvider(): BullMqQueues {
  if (!sharedProvider) {
    sharedProvider = new BullMqQueues({
      connection: getSharedConnection(),
      prefix: SHARED_PROVIDER_PREFIX,
      defaultLeaseMs: 150,
      stalledInterval: 50,
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 10 },
    })
  }
  return sharedProvider
}

/**
 * Clears every key on the dedicated test Redis. Called in the contract suite's per-test
 * `teardown` to give the next case a clean slate — the provider stays alive, only the data
 * goes. Safe because the test Redis container (`docker-compose.yml`, port 46379) is isolated
 * and used by this suite only.
 */
export async function flushSharedRedis(): Promise<void> {
  await getSharedConnection().flushdb()
}

/** Closes the suite-level shared provider. Call from `afterAll`. Safe to call multiple times. */
export async function closeSharedProvider(): Promise<void> {
  if (!sharedProvider) return
  const provider = sharedProvider
  sharedProvider = undefined
  await provider.close()
}
