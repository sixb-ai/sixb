import { describe, expect, test } from "bun:test"
import { defineObjectType, link, OntologyRegistry, prop } from "../ontology"
import { linkBatchKey, objectBatchKey, objectLinkCursor, type Storage } from "../storage"
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
const OpaqueA = defineObjectType({
  id: "A",
  name: "Opaque A",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link.self("D", { cardinality: "many" })],
})
const OpaqueAB = defineObjectType({
  id: "A:B",
  name: "Opaque AB",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link.self("D", { cardinality: "many" })],
})
const ontology = new OntologyRegistry({ sources: [Device, OpaqueA, OpaqueAB] })

export function runEffectiveStorageContractSuite<TStorage extends Storage>(
  name: string,
  provider: EffectiveStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await provider.createStorage()
    try {
      await seedEffectiveState(storage)
      await body(storage)
    } finally {
      await provider.cleanup?.(storage)
    }
  }

  describe(name, () => {
    test("reads Materializer-owned objects", async () => {
      await withStorage(async (storage) => {
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
        expect([...batch.keys()]).toEqual([objectBatchKey(Device.id, "a")])
      })
    })

    test("reads Materializer-owned links", async () => {
      await withStorage(async (storage) => {
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
        expect(linksByScope.get(linkBatchKey(Device.id, "a", "peers"))).toHaveLength(2)
      })
    })

    test("pages and filters incident links in the provider", async () => {
      await withStorage(async (storage) => {
        const first = await storage.objects.queryLinks({
          projectId,
          objectRefs: [{ objectTypeId: Device.id, primaryId: "a" }],
          direction: "outgoing",
          linkId: "peers",
          endpointObjectTypeIds: [Device.id],
          limit: 1,
        })
        expect(first.links.map((row) => row.targetId)).toEqual(["b"])
        expect(first.hasMore).toBe(true)

        const second = await storage.objects.queryLinks({
          projectId,
          objectRefs: [{ objectTypeId: Device.id, primaryId: "a" }],
          direction: "outgoing",
          linkId: "peers",
          endpointObjectTypeIds: [Device.id],
          after: objectLinkCursor(first.links[0]),
          limit: 1,
        })
        expect(second.links.map((row) => row.targetId)).toEqual(["c"])
        expect(second.hasMore).toBe(false)

        const duplicateRefs = await storage.objects.queryLinks({
          projectId,
          objectRefs: [
            { objectTypeId: Device.id, primaryId: "a" },
            { objectTypeId: Device.id, primaryId: "a" },
          ],
          direction: "outgoing",
          limit: 10,
        })
        expect(duplicateRefs.links.map((row) => row.targetId)).toEqual(["b", "c"])

        const incoming = await storage.objects.queryLinks({
          projectId,
          objectRefs: [{ objectTypeId: Device.id, primaryId: "b" }],
          direction: "incoming",
          limit: 10,
        })
        expect(incoming.links.map((row) => [row.sourceId, row.targetId])).toEqual([["a", "b"]])

        const bothDirections = await storage.objects.queryLinks({
          projectId,
          objectRefs: [
            { objectTypeId: Device.id, primaryId: "a" },
            { objectTypeId: Device.id, primaryId: "b" },
          ],
          direction: "both",
          endpointObjectTypeIds: [Device.id],
          limit: 10,
        })
        expect(bothDirections.links.map((row) => [row.sourceId, row.targetId])).toEqual([
          ["a", "b"],
          ["a", "c"],
        ])

        const unauthorized = await storage.objects.queryLinks({
          projectId,
          objectRefs: [{ objectTypeId: Device.id, primaryId: "a" }],
          direction: "both",
          endpointObjectTypeIds: [],
          limit: 10,
        })
        expect(unauthorized).toEqual({ links: [], hasMore: false })
      })
    })

    test("keeps delimiter-bearing object and batch-link identities distinct", async () => {
      await withStorage(async (storage) => {
        const opaqueProjectId = `${projectId}-opaque-batch-keys`
        const fixture = createMaterializerTestFixture({
          projectId: opaqueProjectId,
          ontology,
          storage,
        })
        await fixture.seed({
          objects: [
            {
              ref: { objectTypeId: OpaqueA.id, primaryId: "B:C" },
              properties: { id: "B:C", name: "First" },
            },
            {
              ref: { objectTypeId: OpaqueAB.id, primaryId: "C" },
              properties: { id: "C", name: "Second" },
            },
          ],
          links: [
            {
              ref: {
                source: { objectTypeId: OpaqueA.id, primaryId: "B:C" },
                linkId: "D",
                target: { objectTypeId: OpaqueA.id, primaryId: "B:C" },
              },
            },
            {
              ref: {
                source: { objectTypeId: OpaqueAB.id, primaryId: "C" },
                linkId: "D",
                target: { objectTypeId: OpaqueAB.id, primaryId: "C" },
              },
            },
          ],
        })

        const objects = await storage.objects.getByPrimaryIdBatch({
          projectId: opaqueProjectId,
          items: [
            { objectTypeId: OpaqueA.id, primaryId: "B:C" },
            { objectTypeId: OpaqueAB.id, primaryId: "C" },
          ],
        })
        expect(objects.get(objectBatchKey(OpaqueA.id, "B:C"))?.properties.name).toBe("First")
        expect(objects.get(objectBatchKey(OpaqueAB.id, "C"))?.properties.name).toBe("Second")

        const links = await storage.objects.listLinksBatch({
          projectId: opaqueProjectId,
          items: [
            { objectTypeId: OpaqueA.id, objectId: "B:C", linkId: "D" },
            { objectTypeId: OpaqueAB.id, objectId: "C", linkId: "D" },
          ],
        })
        expect(links.get(linkBatchKey(OpaqueA.id, "B:C", "D"))).toHaveLength(1)
        expect(links.get(linkBatchKey(OpaqueAB.id, "C", "D"))).toHaveLength(1)
      })
    })

    test("preserves distinct incident links when opaque ids contain delimiters", async () => {
      await withStorage(async (storage) => {
        const opaqueIdsProjectId = `${projectId}-opaque-link-ids`
        const firstSourceId = "opaque:source"
        const firstTargetId = `target:peers:${Device.id}:opaque:end`
        const secondSourceId = `${firstSourceId}:peers:${Device.id}:target`
        const secondTargetId = "opaque:end"
        const fixture = createMaterializerTestFixture({
          projectId: opaqueIdsProjectId,
          ontology,
          storage,
        })
        await fixture.seed({
          objects: [
            device(firstSourceId, "First source"),
            device(firstTargetId, "First target"),
            device(secondSourceId, "Second source"),
            device(secondTargetId, "Second target"),
          ],
          links: [peer(firstSourceId, firstTargetId), peer(secondSourceId, secondTargetId)],
        })

        const incident = await storage.objects.listIncidentLinksBatch({
          projectId: opaqueIdsProjectId,
          items: [
            { objectTypeId: Device.id, objectId: firstSourceId },
            { objectTypeId: Device.id, objectId: secondSourceId },
          ],
        })
        const matching = incident.filter(
          (row) => row.sourceId === firstSourceId || row.sourceId === secondSourceId
        )

        expect(matching.map((row) => [row.sourceId, row.linkId, row.targetId])).toEqual(
          expect.arrayContaining([
            [firstSourceId, "peers", firstTargetId],
            [secondSourceId, "peers", secondTargetId],
          ])
        )
        expect(matching).toHaveLength(2)
      })
    })

    test("pages Materializer-owned objects with a stable cursor", async () => {
      await withStorage(async (storage) => {
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
      })
    })

    test("reads Materializer-owned telemetry", async () => {
      await withStorage(async (storage) => {
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
      })
    })
  })
}

async function seedEffectiveState(storage: Storage): Promise<void> {
  const fixture = createMaterializerTestFixture({ projectId, ontology, storage })
  await fixture.seed({
    objects: [device("a", "Alpha"), device("b", "Beta"), device("c", "Gamma")],
    links: [peer("a", "b"), peer("a", "c")],
    telemetry: [
      temperature("a", 20, "2026-01-01T10:00:00.000Z"),
      temperature("a", 22, "2026-01-01T12:00:00.000Z"),
      temperature("b", 18, "2026-01-01T11:00:00.000Z"),
    ],
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
