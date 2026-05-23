import { NatsBroker } from "../src"

/**
 * Build a NatsBroker wired against the test nats-server. Each broker gets a
 * unique namespace so shared contract tests can reuse stable project ids
 * without colliding with parallel runs.
 */
export function createTestBroker(): {
  broker: NatsBroker
  projectId: string
  cleanup: () => Promise<void>
} {
  const natsUrl = process.env.NATS_URL
  if (!natsUrl) {
    throw new Error(
      "[NatsBroker test] NATS_URL is required. Run `bun run test:e2e` from the @sixb/broker-nats package."
    )
  }

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const namespace = `sixb_test_${suffix}`
  const projectId = `project_${suffix}`
  const broker = new NatsBroker({
    connection: { servers: natsUrl },
    namespace,
  })

  const cleanup = async (): Promise<void> => {
    await broker.close()
  }

  return { broker, projectId, cleanup }
}
