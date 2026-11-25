import { describe, expect, test } from "bun:test"
import {
  defineConnector,
  defineWebhook,
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

/** The host as `sixb dev --from production` starts it, or as production does. */
function createHost(input: { branch: boolean; handled: string[]; storage: InMemoryStorage }) {
  const connector = defineConnector("github", {
    type: "test",
    webhooks: [
      defineWebhook("events")
        .post()
        .json({ parse: (value: unknown) => value })
        .handle(async () => {
          input.handled.push("events")
          return { status: 200, body: { ok: true } }
        }),
    ],
    connect: () => ({}),
  })

  const options = {
    id: "test-project",
    ontology: [],
    broker: new InMemoryBroker(),
    storage: input.storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    connectors: [connector],
  }

  return new SixbHost(
    input.branch
      ? putOnBranch(options, { name: "feature/invoices", dataFrom: "production" })
      : options
  )
}

function deliver(host: SixbHost) {
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  return app.fetch(
    new Request("http://localhost/api/webhooks/github/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "opened" }),
    })
  )
}

describe("webhooks on a branch", () => {
  // Guard check: remove the `host.branch` check in `registerWebhookRoutes`
  // (`routes/webhooks.ts`): the branch admits the delivery and runs the handler.
  test("are refused before a run is admitted or the handler runs", async () => {
    const handled: string[] = []

    const production = createHost({ branch: false, handled, storage: new InMemoryStorage() })
    expect((await deliver(production)).status).toBe(200)
    expect(handled).toEqual(["events"])

    const storage = new InMemoryStorage()
    const branch = createHost({ branch: true, handled, storage })
    const response = await deliver(branch)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error:
        `[Sixb] Branch "feature/invoices": webhook 'github/events' is not received on a branch: ` +
        "providers call production. Test it in production, once merged.",
    })
    expect(handled).toEqual(["events"])

    const runs = await storage.webhookRuns.list({
      projectId: "test-project",
      connectorId: "github",
      webhookId: "events",
    })
    expect(runs.total).toBe(0)
  })
})
