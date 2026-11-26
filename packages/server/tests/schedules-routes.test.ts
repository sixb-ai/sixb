import { describe, expect, test } from "bun:test"
import {
  col,
  defineConnector,
  defineDataset,
  defineSchedule,
  defineSync,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { putOnBranch } from "@sixb/core/internal/runtime"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const erp = defineConnector("erp", { type: "sql", connect: () => ({}) })
const rawInvoices = defineDataset("raw.invoices", { schema: [col("id", "string")] })
const nightly = defineSchedule("nightly").cron("0 2 * * *")
const importInvoices = defineSync("import-invoices")
  .when(nightly)
  .from(erp)
  .read(() => [])
  .intoDataset(rawInvoices)

function createApp(onBranch = false) {
  const options = {
    id: "test-project",
    ontology: [],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    connectors: [erp],
    datasets: [rawInvoices],
    syncs: [importInvoices],
    schedules: [nightly],
  }
  const host = new SixbHost(
    onBranch ? putOnBranch(options, { name: "feature/invoices", dataFrom: "production" }) : options
  )
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  return { host, app }
}

function runSchedule(app: ReturnType<typeof createApp>["app"], scheduleId: string) {
  return app.fetch(
    new Request(`http://localhost/api/schedules/${scheduleId}/runs`, { method: "POST" })
  )
}

describe("schedule routes", () => {
  test("run a cron schedule now, as its next occurrence would", async () => {
    const { host, app } = createApp()

    const response = await runSchedule(app, "nightly")

    expect(response.status).toBe(202)
    const run = (await response.json()) as { occurrenceKey: string; triggeredAt: string }
    expect(run).toMatchObject({ scheduleId: "nightly" })

    const triggered = (await host.events.read({ limit: 10 })).filter(
      (event) => event.type === "schedule.triggered"
    )
    expect(triggered.map((event) => event.payload)).toEqual([
      {
        scheduleId: "nightly",
        occurrenceAt: run.triggeredAt,
        triggeredAt: run.triggeredAt,
        occurrenceKey: run.occurrenceKey,
      },
    ])
  })

  test("answer 409 on a branch for a schedule that starts a sync", async () => {
    const { host, app } = createApp(true)

    const response = await runSchedule(app, "nightly")

    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toContain(
      "schedule 'nightly' starts sync 'import-invoices'"
    )
    expect(await host.events.read({ limit: 10 })).toEqual([])
  })

  test("answer 404 for a schedule that does not exist", async () => {
    const { app } = createApp()

    expect((await runSchedule(app, "missing")).status).toBe(404)
  })
})
