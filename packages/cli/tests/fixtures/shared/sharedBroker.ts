import { appendFileSync } from "node:fs"
import { type Broker, InMemoryBroker } from "@sixb/core"

function logFixtureEvent(entry: Record<string, unknown>): void {
  const logPath = process.env.SIXB_CLI_TEST_LOG
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

/**
 * A broker that behaves like `InMemoryBroker` but is not one, and does not declare
 * `processLocal`.
 *
 * That is what lets a production-role fixture boot: the shareability guard refuses
 * `InMemoryBroker` because a real deployment running the API and the workers as
 * separate processes would publish events nobody can see. A single-process test host
 * has no such problem, and this is the intended way to say so — implement the contract
 * rather than reach for a flag that would also silence the guard in production.
 *
 * Shared by the `prod-roles` and `worker-group` fixtures so the delegation only has to
 * follow the `Broker` interface in one place. `SharedQueues` is deliberately NOT shared:
 * the two fixtures need different queue behaviour.
 */
export class SharedBroker implements Broker {
  private readonly inner = new InMemoryBroker()

  ensureStream: Broker["ensureStream"] = (params) => this.inner.ensureStream(params)
  append: Broker["append"] = (params) => this.inner.append(params)
  read: Broker["read"] = (params) => this.inner.read(params)
  tail: Broker["tail"] = (params) => this.inner.tail(params)
  latestCursor: Broker["latestCursor"] = (params) => this.inner.latestCursor(params)
  subscribe: Broker["subscribe"] = (params, handler) => this.inner.subscribe(params, handler)

  async close(): Promise<void> {
    logFixtureEvent({ type: "broker:close" })
  }
}
