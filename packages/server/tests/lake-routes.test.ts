import { describe, expect, test } from "bun:test"
import {
  can,
  col,
  defineDataset,
  defineGroup,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeMaintenanceOptions,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import type { DatasetStorageHealth, LakeMaintenance } from "@sixb/core/lake-storage"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "lake-routes-tests"

const invoices = defineDataset("raw.invoices", { schema: [col("id", "string")] })
const salaries = defineDataset("raw.salaries", { schema: [col("id", "string")] })

const staff = defineGroup("staff")
const reader = defineRole("reader", { grantedTo: [staff], grants: [can.view(invoices)] })

function health(datasetId: string): DatasetStorageHealth {
  return {
    datasetId,
    materialized: true,
    rowCount: 120,
    dataFiles: 3,
    smallDataFiles: 2,
    dataBytes: 4_096,
    deleteFiles: 1,
    inlinedRows: 4,
    retainedSnapshots: 7,
    partitionBy: ["region"],
    warnings: [{ code: "partitioned-small-dataset", message: "Partitioned below a million rows." }],
  }
}

class MaintainedLakeStorage extends InMemoryLakeStorage {
  readonly described: (readonly string[])[] = []

  readonly maintenance: LakeMaintenance = {
    applyRetention: async () => {
      throw new Error("the route never runs retention")
    },
    describeStorage: async (datasetIds) => {
      this.described.push(datasetIds)
      return datasetIds.map(health)
    },
  }
}

async function createApp(
  input: { lakeStorage?: InMemoryLakeStorage; lakeMaintenance?: LakeMaintenanceOptions } = {}
) {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    datasets: [invoices, salaries],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: input.lakeStorage ?? new MaintainedLakeStorage(),
    lakeMaintenance: input.lakeMaintenance,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [staff],
    roles: [reader],
    auth: { id: "test", kind: "dev" },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )

  return { app, storage }
}

async function seedSession(storage: InMemoryStorage, userId: string, groupIds: readonly string[]) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({ id: userId, projectId, email: `${userId}@acme.com` })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId,
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-11-05T10:00:00.000Z"),
    expiresAt: new Date("2099-11-05T10:00:00.000Z"),
  })

  return { cookie: `sixb_session_app=${credential.cookieValue}` }
}

const url = "http://localhost/api/lake/health"

describe("GET /api/lake/health", () => {
  // Reproduce: describe `host.definitions.datasets.list()` in routes/lake.ts.
  test("describes the datasets the caller may view, with the retention settings", async () => {
    const lakeStorage = new MaintainedLakeStorage()
    const { app, storage } = await createApp({
      lakeStorage,
      lakeMaintenance: { keepVersionsFor: "3d", cleanupEvery: "30m" },
    })
    const headers = await seedSession(storage, "usr_staff", [staff.id])

    const response = await app.fetch(new Request(url, { headers }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      available: true,
      cleanup: {
        enabled: true,
        keepVersionsFor: "3d",
        deleteFilesAfter: "7d",
        cleanupEvery: "30m",
      },
      datasets: [health(invoices.id)],
    })
    expect(lakeStorage.described).toEqual([[invoices.id]])
  })

  test("asks the provider nothing when the caller may view no dataset", async () => {
    const lakeStorage = new MaintainedLakeStorage()
    const { app, storage } = await createApp({ lakeStorage })
    const headers = await seedSession(storage, "usr_outsider", [])

    const response = await app.fetch(new Request(url, { headers }))

    expect(await response.json()).toMatchObject({ available: true, datasets: [] })
    expect(lakeStorage.described).toEqual([])
  })

  test("says when the lake storage provider has no maintenance", async () => {
    const { app, storage } = await createApp({ lakeStorage: new InMemoryLakeStorage() })
    const headers = await seedSession(storage, "usr_staff", [staff.id])

    const response = await app.fetch(new Request(url, { headers }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ available: false, datasets: [] })
  })
})
