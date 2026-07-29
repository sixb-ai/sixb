import { expect, test } from "bun:test"
import { defineObjectType, link, OntologyRegistry, prop } from "../ontology"
import type { Storage } from "../storage"
import { createMaterializerTestFixture } from "./materializer-fixture"

export interface EffectiveStorageContractSuiteOptions<TStorage extends Storage> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "effective-storage-contract"
const Device = defineObjectType({
  id: "EffectiveStorageDevice",
  name: "Device",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string", { required: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [link.self("peers", { cardinality: "many" })],
})
const ontology = new OntologyRegistry({ sources: [Device] })

export function runEffectiveStorageContractSuite<TStorage extends Storage>(
  name: string,
  provider: EffectiveStorageContractSuiteOptions<TStorage>
): void {
  test(`${name} reads Materializer-owned effective state`, async () => {
    const storage = await provider.createStorage()
    const fixture = createMaterializerTestFixture({ projectId, ontology, storage })
    try {
      await fixture.seed({
        objects: [device("a", "Alpha"), device("b", "Beta"), device("c", "Gamma")],
        links: [peer("a", "b"), peer("a", "c")],
        telemetry: [
          temperature("a", 20, "2026-01-01T10:00:00.000Z"),
          temperature("a", 22, "2026-01-01T12:00:00.000Z"),
          temperature("b", 18, "2026-01-01T11:00:00.000Z"),
        ],
      })

      const object = await storage.objects.getByPrimaryId({
        projectId,
        objectTypeId: Device.id,
        primaryId: "a",
      })
      expect(object).toMatchObject({
        properties: { id: "a", name: "Alpha", temperature: 22 },
        version: 2,
      })
      expect(typeof object?.lastCommitId).toBe("string")

      const batch = await storage.objects.getByPrimaryIdBatch({
        projectId,
        items: [
          { objectTypeId: Device.id, primaryId: "a" },
          { objectTypeId: Device.id, primaryId: "missing" },
        ],
      })
      expect([...batch.keys()]).toEqual([`${Device.id}:a`])

      const outgoing = await storage.objects.listLinks({
        projectId,
        objectTypeId: Device.id,
        objectId: "a",
      })
      expect(outgoing.map((row) => row.targetId).sort()).toEqual(["b", "c"])
      expect(outgoing.every((row) => row.lastCommitId.length > 0)).toBe(true)

      const incoming = await storage.objects.listIncidentLinksBatch({
        projectId,
        items: [{ objectTypeId: Device.id, objectId: "b" }],
      })
      expect(incoming).toHaveLength(1)
      expect(incoming[0]).toMatchObject({ sourceId: "a", targetId: "b" })

      const linksByScope = await storage.objects.listLinksBatch({
        projectId,
        items: [{ objectTypeId: Device.id, objectId: "a", linkId: "peers" }],
      })
      expect(linksByScope.get(`${Device.id}:a:peers`)).toHaveLength(2)

      const firstPage = await storage.objects.listByPrimaryIdPage({
        projectId,
        objectTypeId: Device.id,
        limit: 2,
      })
      expect(firstPage.objects.map((row) => row.primaryId)).toEqual(["a", "b"])
      expect(firstPage.nextPrimaryId).toBe("b")
      const secondPage = await storage.objects.listByPrimaryIdPage({
        projectId,
        objectTypeId: Device.id,
        afterPrimaryId: firstPage.nextPrimaryId,
        limit: 2,
      })
      expect(secondPage.objects.map((row) => row.primaryId)).toEqual(["c"])

      const descending = await storage.timeseries.getHistory({
        projectId,
        objectTypeId: Device.id,
        objectId: "a",
        propertyId: "temperature",
        from: new Date("2026-01-01T10:30:00.000Z"),
        order: "desc",
      })
      expect(descending.map((point) => point.value)).toEqual([22])
      expect(typeof descending[0]?.lastCommitId).toBe("string")

      const histories = await storage.timeseries.getHistoryBatch({
        projectId,
        series: [
          { objectTypeId: Device.id, objectId: "a", propertyId: "temperature" },
          { objectTypeId: Device.id, objectId: "b", propertyId: "temperature" },
        ],
        limitPerSeries: 1,
        order: "desc",
      })
      expect(histories.map((series) => series.points[0]?.value)).toEqual([22, 18])

      const latest = await storage.timeseries.getLatest({
        projectId,
        objectTypeId: Device.id,
        objectId: "a",
        propertyId: "temperature",
      })
      expect(latest).toMatchObject({ value: 22, at: new Date("2026-01-01T12:00:00.000Z") })
    } finally {
      await provider.cleanup?.(storage)
    }
  })
}

function device(primaryId: string, name: string) {
  return {
    ref: { objectTypeId: Device.id, primaryId },
    properties: { id: primaryId, name },
  }
}

function peer(sourceId: string, targetId: string) {
  return {
    ref: {
      source: { objectTypeId: Device.id, primaryId: sourceId },
      linkId: "peers",
      target: { objectTypeId: Device.id, primaryId: targetId },
    },
  }
}

function temperature(objectId: string, value: number, at: string) {
  return {
    series: {
      object: { objectTypeId: Device.id, primaryId: objectId },
      propertyId: "temperature",
    },
    value,
    at,
  }
}
