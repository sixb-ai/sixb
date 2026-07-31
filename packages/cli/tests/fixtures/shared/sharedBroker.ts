import { appendFileSync } from "node:fs"
import { type Broker, InMemoryBroker } from "@sixb/core"

function logFixtureEvent(entry: Record<string, unknown>): void {
  const logPath = process.env.SIXB_CLI_TEST_LOG
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

/**
 * A broker that behaves like `InMemoryBroker` and declares `scope: "shared"`, which is what lets
 * a production-role fixture boot past the shareability guard on a single-process test host.
 *
 * Shared by the `prod-roles` and `worker-group` fixtures. `SharedQueues` is not: they need
 * different queue behaviour.
 */
export class SharedBroker implements Broker {
  readonly scope = "shared" as const
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
