import { describe, expect, test } from "bun:test"
import type { DatasetDefinition, LakeStorage, SixbHostView } from "@sixb/core"
import { col, defineDataset } from "@sixb/core"
import type { DatasetCatalogState } from "@sixb/core/lake-storage"
import { Elysia } from "elysia"
import { registerDatasetRoutes } from "../src/routes/datasets"

/**
 * A LakeStorage that only answers the bulk catalog read. Any per-dataset call
 * the route should have avoided throws, so the test fails loudly if the route
 * regresses to a `getDataset`/`getLatestVersion` loop.
 */
function createCatalogOnlyStorage(states: readonly DatasetCatalogState[]) {
  let listDatasetCatalogStateCalls = 0
  const storage = {
    async listDatasetCatalogState(
      datasetIds: readonly string[]
    ): Promise<readonly DatasetCatalogState[]> {
      listDatasetCatalogStateCalls += 1
      return datasetIds.map(
        (datasetId) =>
          states.find((state) => state.datasetId === datasetId) ?? {
            datasetId,
            materialized: false,
            latestVersion: null,
          }
      )
    },
    async getDataset() {
      throw new Error("getDataset must not be called from the catalog list route")
    },
    async getLatestVersion() {
      throw new Error("getLatestVersion must not be called from the catalog list route")
    },
    async listDatasets() {
      throw new Error("listDatasets must not be called from the catalog list route")
    },
  }

  return {
    storage: storage as unknown as LakeStorage,
    calls: () => listDatasetCatalogStateCalls,
  }
}

function createSixbStub(
  lakeStorage: LakeStorage,
  definitions: readonly DatasetDefinition[]
): SixbHostView {
  return {
    lakeStorage,
    definitions: {
      datasets: {
        list: () => definitions,
        getById: (id: string) => definitions.find((definition) => definition.id === id) ?? null,
      },
      syncs: { list: () => [] },
      pipelines: { list: () => [] },
      projections: { list: () => [] },
    },
  } as unknown as SixbHostView
}

function createTestApp(lakeStorage: LakeStorage, definitions: readonly DatasetDefinition[]) {
  const sixb = createSixbStub(lakeStorage, definitions)
  const sixbExecution = {
    datasets: sixb.definitions.datasets,
    syncs: sixb.definitions.syncs,
    pipelines: sixb.definitions.pipelines,
    projections: sixb.definitions.projections,
  }
  const app = new Elysia()
  app.derive(() => ({ sixb: sixbExecution }))

  return registerDatasetRoutes(app, sixb)
}

const definitions: DatasetDefinition[] = [
  defineDataset("raw.catalog.dataset_0", {
    schema: [col("source", "string"), col("id", "string")],
    primaryKey: ["source", "id"],
  }),
  ...Array.from({ length: 4 }, (_, index) =>
    defineDataset(`raw.catalog.dataset_${index + 1}`, { schema: [col("id", "string")] })
  ),
]

const states: DatasetCatalogState[] = definitions.map((definition, index) => ({
  datasetId: definition.id,
  materialized: true,
  latestVersion: {
    datasetId: definition.id,
    versionId: `ducklake:${index + 1}`,
    mode: "snapshot",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    rowCount: 2,
  },
}))

describe("dataset catalog routes", () => {
  test("list route reads bulk catalog state once, never per-dataset reads", async () => {
    const { storage, calls } = createCatalogOnlyStorage(states)
    const app = createTestApp(storage, definitions)

    const response = await app.handle(new Request("http://localhost/api/datasets"))
    expect(response.status).toBe(200)

    const body = (await response.json()) as Array<{
      id: string
      primaryKey?: string | string[]
      materialized: boolean
      latestVersion: { versionId: string; mode: string; rowCount?: number } | null
    }>

    expect(body).toHaveLength(5)
    expect(body[0]?.primaryKey).toEqual(["source", "id"])
    for (const item of body) {
      expect(item.materialized).toBe(true)
      expect(item.latestVersion?.mode).toBe("snapshot")
      expect(item.latestVersion?.rowCount).toBe(2)
      expect(item.latestVersion?.versionId).toMatch(/^ducklake:\d+$/)
    }

    expect(calls()).toBe(1)
  })

  test("single route reads catalog state without per-dataset reads", async () => {
    const { storage, calls } = createCatalogOnlyStorage(states)
    const app = createTestApp(storage, definitions)

    const response = await app.handle(
      new Request(`http://localhost/api/datasets/${definitions[0].id}`)
    )
    expect(response.status).toBe(200)

    const item = (await response.json()) as {
      primaryKey?: string | string[]
      materialized: boolean
      latestVersion: { mode: string } | null
    }
    expect(item.materialized).toBe(true)
    expect(item.primaryKey).toEqual(["source", "id"])
    expect(item.latestVersion?.mode).toBe("snapshot")

    expect(calls()).toBe(1)
  })
})
