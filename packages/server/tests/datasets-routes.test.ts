import { describe, expect, test } from "bun:test"
import type { DatasetDefinition, LakeStorage, OntologySource, Sixb } from "@sixb/core"
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
): Sixb<readonly OntologySource[]> {
  return {
    lakeStorage,
    listDatasets: () => definitions,
    getDatasetById: (id: string) => definitions.find((definition) => definition.id === id) ?? null,
    listSyncs: () => [],
    listPipelines: () => [],
    listObjectProjections: () => [],
    listLinkProjections: () => [],
    listTelemetryProjections: () => [],
  } as unknown as Sixb<readonly OntologySource[]>
}

const definitions: DatasetDefinition[] = Array.from({ length: 5 }, (_, index) =>
  defineDataset(`raw.catalog.dataset_${index}`, { schema: [col("id", "string")] })
)

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
    const app = registerDatasetRoutes(new Elysia(), createSixbStub(storage, definitions))

    const response = await app.handle(new Request("http://localhost/api/datasets"))
    expect(response.status).toBe(200)

    const body = (await response.json()) as Array<{
      id: string
      materialized: boolean
      latestVersion: { versionId: string; mode: string; rowCount?: number } | null
    }>

    expect(body).toHaveLength(5)
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
    const app = registerDatasetRoutes(new Elysia(), createSixbStub(storage, definitions))

    const response = await app.handle(
      new Request(`http://localhost/api/datasets/${definitions[0].id}`)
    )
    expect(response.status).toBe(200)

    const item = (await response.json()) as {
      materialized: boolean
      latestVersion: { mode: string } | null
    }
    expect(item.materialized).toBe(true)
    expect(item.latestVersion?.mode).toBe("snapshot")

    expect(calls()).toBe(1)
  })
})
