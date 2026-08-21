import { describe, expect, test } from "bun:test"
import type { SixbHostView } from "@sixb/core"
import { change, col, defineConnector, defineDataset, defineSync } from "@sixb/core"
import type {
  ListLatestSyncRunsInput,
  SixbFailure,
  SyncRunFailureCode,
  SyncRunStorage,
} from "@sixb/core/storage"
import { Elysia } from "elysia"
import { registerSyncRoutes } from "../src/routes/syncs"

const connector = defineConnector("source", {
  type: "test",
  async connect() {
    return {}
  },
})

const ordersDataset = defineDataset("raw.erp.orders", {
  schema: [col("orderId", "string")],
})

const customersDataset = defineDataset("raw.crm.customers", {
  schema: [col("customerId", "string")],
})

const invoicesDataset = defineDataset("raw.erp.invoices", {
  schema: [col("invoiceId", "string")],
  primaryKey: "invoiceId",
})

const syncs = [
  defineSync("sync-orders")
    .from(connector)
    .read(() => [])
    .intoDataset(ordersDataset),
  defineSync("sync-customers", { mode: "append" })
    .from(connector)
    .read(() => [])
    .intoDataset(customersDataset),
  defineSync("sync-invoices", { mode: "merge" })
    .from(connector)
    .read(() => change.delete({ invoiceId: "missing" }))
    .intoDataset(invoicesDataset),
]

const FAILURE: SixbFailure<SyncRunFailureCode> = {
  code: "internal.unexpected",
  message: "Provider offline",
  retryable: false,
  at: "2026-04-06T16:00:01.000Z",
  details: { provider: "erp" },
}

function createSixbStub(syncRuns: Partial<SyncRunStorage>): SixbHostView {
  return {
    id: "my-app",
    storage: {
      syncRuns,
    },
    definitions: {
      syncs: {
        list: () => syncs,
        getById: (id: string) => syncs.find((sync) => sync.id === id) ?? null,
      },
    },
  } as unknown as SixbHostView
}

function createTestApp(syncRuns: Partial<SyncRunStorage>) {
  const sixb = createSixbStub(syncRuns)
  const sixbExecution = {
    syncs: {
      list: () => sixb.definitions.syncs.list(),
      getById: (syncId: string) => sixb.definitions.syncs.getById(syncId),
      runs: {
        listLatest: (syncIds: readonly string[]) =>
          syncRuns.listLatestBySyncIds?.({ projectId: sixb.id, syncIds }),
      },
    },
  }
  const app = new Elysia()
  app.derive(() => ({ sixb: sixbExecution }))

  return registerSyncRoutes(app, sixb)
}

describe("sync routes", () => {
  test("list route bulk loads latest sync runs once", async () => {
    let bulkCalls = 0
    let listCalls = 0
    const requestedSyncIds: string[][] = []

    const app = createTestApp({
      async list() {
        listCalls += 1
        throw new Error("list must not be called from the sync list route")
      },
      async listLatestBySyncIds(input: ListLatestSyncRunsInput) {
        bulkCalls += 1
        requestedSyncIds.push([...input.syncIds])
        return {
          runs: [
            {
              id: "run-customers",
              projectId: "my-app",
              syncId: "sync-customers",
              datasetId: "raw.crm.customers",
              mode: "append",
              status: "failed",
              startedAt: new Date("2026-04-06T16:00:00.000Z"),
              finishedAt: new Date("2026-04-06T16:00:01.000Z"),
              error: FAILURE,
            },
            {
              id: "run-invoices",
              projectId: "my-app",
              syncId: "sync-invoices",
              datasetId: "raw.erp.invoices",
              mode: "merge",
              status: "running",
              startedAt: new Date("2026-04-06T16:00:00.000Z"),
            },
          ],
        }
      },
    })

    const response = await app.handle(new Request("http://localhost/api/syncs"))
    expect(response.status).toBe(200)

    const body = (await response.json()) as Array<{
      id: string
      target: { dataset: { primaryKey?: string | string[] } }
      latestRun: {
        id: string
        syncId: string
        status: string
        error?: SixbFailure<SyncRunFailureCode>
      } | null
    }>

    expect(bulkCalls).toBe(1)
    expect(listCalls).toBe(0)
    expect(requestedSyncIds).toEqual([["sync-orders", "sync-customers", "sync-invoices"]])
    expect(body.map((sync) => [sync.id, sync.latestRun?.id ?? null])).toEqual([
      ["sync-orders", null],
      ["sync-customers", "run-customers"],
      ["sync-invoices", "run-invoices"],
    ])
    expect(body.find((sync) => sync.id === "sync-invoices")?.target.dataset.primaryKey).toBe(
      "invoiceId"
    )
    expect(body.find((sync) => sync.id === "sync-customers")?.latestRun).toMatchObject({
      status: "failed",
      error: FAILURE,
    })
  })
})
