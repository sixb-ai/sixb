import { randomUUID } from "node:crypto"
import { RedisBroker } from "../src"

export function requireRedisUrl(): string {
  const url = process.env["SIXB_REDIS_BROKER_URL"]
  if (!url) {
    throw new Error(
      "[RedisBroker test] SIXB_REDIS_BROKER_URL is required. Run `bun run test:e2e` from the @sixb/broker-redis package."
    )
  }
  return url
}

/**
 * Build a RedisBroker wired against the test Redis server. Each broker gets a
 * unique prefix and project id so shared contract tests can use stable stream
 * names without colliding with parallel runs.
 */
export function createTestBroker(): {
  broker: RedisBroker
  projectId: string
  cleanup: () => Promise<void>
} {
  const suffix = randomUUID().slice(0, 8)
  const broker = new RedisBroker({
    connection: { url: requireRedisUrl() },
    prefix: `sixb:test:broker:${suffix}`,
    subscribeBlockMs: 100,
  })

  const cleanup = async (): Promise<void> => {
    await broker.close()
  }

  return { broker, projectId: `project-${suffix}`, cleanup }
}
