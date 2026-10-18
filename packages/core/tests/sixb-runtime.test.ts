import { describe, expect, test } from "bun:test"
import {
  defineAction,
  defineObjectType,
  defineOntology,
  defineValueType,
  defineWorkflow,
  defineWorkflowStep,
  link,
  MaterializationValidationError,
  ObjectNotFoundError,
  type ObjectQuery,
  ObjectQueryPlanningError,
  OntologyValidationError,
  optional,
  param,
  prop,
  SixbHost,
  valueTypeRef,
} from "../src"
import { recordEdits } from "../src/edits/recorder"
import type { ObjectStorage, QueryObjectsInput, QueryObjectsResult } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps, waitFor } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("currentTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
    prop("exactReading", "decimal", { mode: "telemetry" }),
  ],
  links: [link.ref("hasThermostat", "Thermostat", { cardinality: "one" })],
})

const Thermostat = defineObjectType({
  id: "Thermostat",
  name: "Thermostat",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
  ],
})

const Document = defineObjectType({
  id: "Document",
  name: "Document",
  properties: [prop("id", "string", { required: true, primary: true }), prop("file", "fileRef")],
})

const SearchCustomer = defineObjectType({
  id: "SearchCustomer",
  name: "Search Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: {
        searchable: true,
        text: true,
        filterable: true,
        sortable: true,
        weight: 3,
      },
    }),
    prop("email", "string", {
      query: { searchable: true, text: true, exact: true },
    }),
    prop("status", "string", {
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop(
      "embedding",
      { type: "array", items: "double" },
      {
        query: { searchable: true },
      }
    ),
  ],
  search: {
    defaultText: ["name", "email"],
  },
})

function findQueryNode(query: ObjectQuery, kind: ObjectQuery["kind"]): ObjectQuery | null {
  if (query.kind === kind) return query
  if ("input" in query) return findQueryNode(query.input, kind)
  return null
}

function countObjectQueryCalls(deps: ReturnType<typeof createTestRuntimeDeps>): {
  readonly calls: number
} {
  let calls = 0
  const queryObjects = deps.storage.objects.queryObjects
  if (!queryObjects) throw new Error("Expected in-memory object query pushdown.")
  const originalQueryObjects = queryObjects.bind(deps.storage.objects)
  deps.storage.objects.queryObjects = async (
    input: QueryObjectsInput
  ): Promise<QueryObjectsResult> => {
    calls += 1
    return originalQueryObjects(input)
  }

  return {
    get calls() {
      return calls
    },
  }
}

function disableObjectQueryPushdown(deps: ReturnType<typeof createTestRuntimeDeps>): void {
  const objectStorage = deps.storage.objects as ObjectStorage
  objectStorage.queryCapabilities = () => ({
    queryObjects: false,
    notes: ["Object query pushdown disabled for this test."],
  })
  objectStorage.queryObjects = undefined
}

describe("SixbHost runtime", () => {
  test("canonicalizes the project locale and time zone and rejects invalid ones", () => {
    const deps = createTestRuntimeDeps()
    expect(new SixbHost({ ontology: [Room], ...deps })).toMatchObject({
      locale: "en",
      timeZone: "UTC",
    })
    expect(
      new SixbHost({ ontology: [Room], ...deps, locale: "fr-fr", timeZone: "europe/paris" })
    ).toMatchObject({ locale: "fr-FR", timeZone: "Europe/Paris" })
    expect(() => new SixbHost({ ontology: [Room], ...deps, locale: "fr_FR" })).toThrow(
      `[Sixb] 'locale' must be a BCP 47 language tag such as "fr-FR"; received "fr_FR".`
    )
    expect(() => new SixbHost({ ontology: [Room], ...deps, timeZone: "Paris" })).toThrow(
      `[Sixb] 'timeZone' must be an IANA time zone such as "Europe/Paris"; received "Paris".`
    )
  })

  test("builds executable ObjectSet queries", () => {
    const sixb = createTestSixb({ ontology: [SearchCustomer], ...createTestRuntimeDeps() })

    const query = sixb
      .objects(SearchCustomer)
      .query()
      .where((r) => r.and(r.p.status.eq("active"), r.p.name.contains("Acme")))
      .search("acme", { fields: [SearchCustomer.p.name, SearchCustomer.p.email] })
      .orderByRelevance()
      .orderBy(SearchCustomer.p.name, "asc")
      .limit(10)
    const textNode = findQueryNode(query.ir, "text")
    const sortNode = findQueryNode(query.ir, "sort")

    expect(query.ir.kind).toBe("limit")
    expect(textNode?.kind).toBe("text")
    if (textNode?.kind === "text") {
      expect(textNode.fields).toEqual(["name", "email"])
    }
    expect(sortNode?.kind).toBe("sort")
    if (sortNode?.kind === "sort") {
      expect(sortNode.fields).toEqual([
        { kind: "relevance", direction: undefined },
        { kind: "property", propertyId: "name", direction: "asc" },
      ])
    }

    expect(query.validate().result.objectTypeIds).toEqual(["SearchCustomer"])
    expect(query.explain().valid).toBe(true)
    expect(query.formatExplanation()).toContain("ObjectQuery valid")
  })

  test("executes ObjectSet queries through the query executor", async () => {
    const deps = createTestRuntimeDeps()
    const queryCounter = countObjectQueryCalls(deps)
    const sixb = createTestSixb({ ontology: [Room], ...deps })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:103", externalId: "RM-103", name: "Conference 103" },
    })

    const found = await sixb
      .objects(Room)
      .query()
      .where((r) => r.p.externalId.eq("RM-102"))
      .first()
    const listed = await sixb
      .objects(Room)
      .query()
      .where((r) => r.p.name.neq("Conference 103"))
      .limit(10)
      .list()

    expect(found?.primaryId).toBe("room:102")
    expect(
      (listed.objects as readonly { primaryId: string }[]).map((room) => room.primaryId)
    ).toEqual(["room:101", "room:102"])
    expect(queryCounter.calls).toBe(2)
  })

  test("executes fluent traversal queries with post-traverse filters", async () => {
    const sixb = createTestSixb({ ontology: [Room, Thermostat], ...createTestRuntimeDeps() })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    const thermostat = await sixb.objects(Thermostat).upsert({
      properties: { id: "tstat:101", externalId: "T-101", name: "Thermostat 101" },
    })
    await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, thermostat)

    const found = await sixb
      .objects(Room)
      .query()
      .where((room) => room.p.externalId.eq("RM-101"))
      .traverse(Room.l.hasThermostat)
      .where((thermostat) => thermostat.p.id.eq("tstat:101"))
      .first()

    expect(found?.objectTypeId).toBe("Thermostat")
    expect(found?.primaryId).toBe("tstat:101")
  })

  test("lists objects on the storage-list path with pagination, prefix, and type filters", async () => {
    const deps = createTestRuntimeDeps()
    const queryCounter = countObjectQueryCalls(deps)
    const sixb = createTestSixb({ id: "list-test", ontology: [Room, Thermostat], ...deps })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:201", externalId: "RM-201", name: "Conference 201" },
    })
    await sixb.objects(Thermostat).upsert({
      properties: { id: "tstat:abc", externalId: "device-123", name: "Tstat 101" },
    })

    const prefixRooms = await sixb.objects(Room).list({ idPrefix: "room:10" })
    expect(
      (prefixRooms.objects as readonly { primaryId: string }[]).map((room) => room.primaryId).sort()
    ).toEqual(["room:101", "room:102"])

    const page1 = await sixb.objects(Room).list({ limit: 2, orderBy: "primaryId", order: "asc" })
    expect(page1.objects.map((room) => room.primaryId)).toEqual(["room:101", "room:102"])
    expect(page1).toMatchObject({ total: 3, hasMore: true })
    const page2 = await sixb.objects(Room).list({
      limit: 2,
      offset: 2,
      orderBy: "primaryId",
      order: "asc",
    })
    expect(page2.objects.map((room) => room.primaryId)).toEqual(["room:201"])
    expect(page2.hasMore).toBe(false)

    expect((await sixb.objects.list({ limit: 10 })).objects).toHaveLength(4)
    expect((await sixb.objects.list({ objectTypeIds: ["Room"], limit: 10 })).objects).toHaveLength(
      3
    )
    await expect(sixb.objects.list({ objectTypeIds: ["room"] })).rejects.toThrow(
      "Unknown object type 'room'. Object type IDs are case-sensitive."
    )
    expect(queryCounter.calls).toBe(0)
  })

  test("explains how to bound fallback ObjectSet queries before list", async () => {
    const deps = createTestRuntimeDeps()
    disableObjectQueryPushdown(deps)
    const sixb = createTestSixb({ ontology: [Room], ...deps })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })

    try {
      await sixb
        .objects(Room)
        .query()
        .where((r) => r.p.externalId.eq("RM-101"))
        .list()
      throw new Error("Expected unbounded fallback query to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectQueryPlanningError)
      if (error instanceof ObjectQueryPlanningError) {
        expect(error.issues.map((issue) => issue.code)).toContain("fallback_requires_bound")
        expect(error.message).toContain("Add .limit(n) or .page({ pageSize: n }) before .list().")
      }
    }
  })

  test("keeps the configured providers on the host", () => {
    const deps = createTestRuntimeDeps()
    const sixb = new SixbHost({ ontology: [Room], ...deps })

    expect(sixb.lakeStorage).toBe(deps.lakeStorage)
    expect(sixb.blobStorage).toBe(deps.blobStorage)
    expect(sixb.queues).toBe(deps.queues)
  })

  // Each caller boundary checks the media type itself, because the shared validator also
  // re-checks stored state. Regression proof: drop assertValidFileRefs from
  // normalizeRuntimeObject, normalizeRuntimeLink, normalizeObjectEditProperties,
  // normalizeLinkEditProperties, normalizeActionParams, or requestWorkflowRun; that write passes.
  test("rejects a file reference whose media type is not one media type wherever a caller writes it", async () => {
    const Folder = defineObjectType({
      id: "Folder",
      name: "Folder",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link("documents", Document, { properties: [prop("cover", "fileRef")] })],
    })
    const attach = defineAction("attach")
      .on(Document)
      .params({ file: param("fileRef") })
      .writeback(async () => {})
    const noop = defineWorkflowStep("noop")
      .input({ file: "fileRef" })
      .output({})
      .run(async () => ({}))
    const review = defineWorkflow("review").input({ file: "fileRef" }).then(noop)
    const sixb = createTestSixb({
      ontology: [Document, Folder],
      actions: [attach],
      workflows: [review],
      ...createTestRuntimeDeps(),
    })
    const file = await sixb.blobs.put({
      body: new TextEncoder().encode("document bytes"),
      mediaType: "application/pdf",
    })
    const listed = { ...file, mediaType: "image/png,text/html" }
    const rejected = (path: string) =>
      `[Sixb] Property ${path}.mediaType must be one media type, such as "application/pdf"`
    expect(
      (await sixb.objects(Document).upsert({ properties: { id: "doc:1", file } })).properties.file
    ).toEqual(file)
    await sixb.objects(Folder).upsert({ properties: { id: "folder:1" } })
    const documentRef = { objectTypeId: "Document", primaryId: "doc:1" } as const

    await expect(
      sixb.objects(Document).upsert({ properties: { id: "doc:2", file: listed } })
    ).rejects.toThrow(rejected("Document.file"))
    await expect(
      sixb.objects(Folder).upsertLink({
        sourceId: "folder:1",
        linkId: "documents",
        targetTypeId: "Document",
        targetId: "doc:1",
        properties: { cover: listed },
      })
    ).rejects.toThrow(rejected("Folder.documents.cover"))
    await expect(
      recordEdits({ runId: "act_1" }, ({ objects }) => {
        objects(Document).create({ id: "doc:3", file: listed })
      })
    ).rejects.toThrow(rejected("Document.file"))
    await expect(
      recordEdits({ runId: "act_1" }, ({ objects }) => {
        objects(Folder)
          .byId("folder:1")
          .link(Folder.l.documents, documentRef, { properties: { cover: listed } })
      })
    ).rejects.toThrow(rejected("Folder.documents.cover"))
    await expect(
      sixb
        .objects(Document)
        .requestAction({ id: "doc:1", action: attach, params: { file: listed } })
    ).rejects.toThrow(rejected("Document.attach.file"))
    await expect(sixb.workflows.request(review, { input: { file: listed } })).rejects.toThrow(
      rejected('Workflow "review" input.file')
    )

    await expect(
      sixb.objects(Document).requestAction({ id: "doc:1", action: attach, params: { file } })
    ).resolves.toMatchObject({ status: "succeeded" })
    await expect(sixb.workflows.request(review, { input: { file } })).resolves.toMatchObject({
      created: true,
    })
  })

  // Regression proof: drop assertMediaType from blobs.put() in blob-storage/execution.ts.
  test("rejects a blob whose mediaType is not exactly one media type", () => {
    const sixb = createTestSixb({ ontology: [Document], ...createTestRuntimeDeps() })

    expect(() =>
      sixb.blobs.put({
        body: new TextEncoder().encode("file bytes"),
        mediaType: "image/png,text/html",
      })
    ).toThrow('[Sixb] blobs.put() mediaType must be one media type, such as "application/pdf".')
  })

  test("reads telemetry back through the same typed channel that wrote it", async () => {
    const sixb = createTestSixb({
      id: "project-a",
      ontology: [Room, Thermostat],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })

    const temperature = sixb.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature)
    for (const [index, value] of [21.5, 22, 22.5].entries()) {
      await temperature.append({
        value,
        unit: "degreeCelsius",
        at: new Date(Date.UTC(2026, 0, 1, 10, index)),
      })
    }

    // Before `history()`, reading this back meant leaving the typed surface for
    // `sixb.storage.timeseries` — telemetry was the only write-only ontology data.
    // Chronological by default, matching `storage.timeseries.getHistoryBatch`.
    const points = await temperature.history()
    expect(points.map((point) => point.value)).toEqual([21.5, 22, 22.5])
    expect(points[0]?.unit).toBe("degreeCelsius")
    expect(points[0]?.at).toEqual(new Date("2026-01-01T10:00:00.000Z"))

    expect((await temperature.history({ order: "desc" })).map((point) => point.value)).toEqual([
      22.5, 22, 21.5,
    ])
    expect((await temperature.history({ limit: 2 })).map((point) => point.value)).toEqual([
      21.5, 22,
    ])

    const optionReads = new Map<string, number>()
    const historyOptions = Object.defineProperties(
      {},
      {
        from: { get: () => countRead(optionReads, "from", undefined) },
        to: { get: () => countRead(optionReads, "to", undefined) },
        limit: { get: () => countRead(optionReads, "limit", 1) },
        order: { get: () => countRead(optionReads, "order", "desc" as const) },
      }
    ) as Parameters<typeof temperature.history>[0]
    expect((await temperature.history(historyOptions)).map((point) => point.value)).toEqual([22.5])
    expect(Object.fromEntries(optionReads)).toEqual({ from: 1, to: 1, limit: 1, order: 1 })

    expect(
      (
        await temperature.history({
          from: new Date("2026-01-01T10:01:00.000Z"),
          to: new Date("2026-01-01T10:01:30.000Z"),
        })
      ).map((point) => point.value)
    ).toEqual([22])

    // An empty series reads as an empty page, not a throw.
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })
    expect(
      await sixb.objects(Room).byId("room:102").telemetry(Room.p.currentTemperature).history()
    ).toEqual([])

    // A principal grant authorizes the telemetry series by type. Historical data remains readable
    // after the materialized object is deleted; only delegated reads depend on live selection.
    await sixb.objects(Room).byId("room:101").delete()
    expect((await temperature.history()).map((point) => point.value)).toEqual([21.5, 22, 22.5])
  })

  test("emits typed events and projects through the runtime dependencies", async () => {
    const runtimeDeps = createTestRuntimeDeps()

    const sixb = createTestSixb({
      id: "project-a",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: {
        id: "room:101",
        externalId: "RM-101",
        name: "Conference 101",
      },
    })

    await sixb
      .objects(Room)
      .byId("room:101")
      .telemetry(Room.p.currentTemperature)
      .append({
        value: 22.4,
        unit: "degreeCelsius",
        at: new Date("2026-01-01T10:00:00.000Z"),
      })

    const tstat = await sixb.objects(Thermostat).upsert({
      properties: {
        id: "tstat:abc",
        externalId: "device-123",
        name: "Tstat 101",
      },
    })

    await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .link(Room.l.hasThermostat, tstat, {
          properties: { installedBy: "tech-a" },
        })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .link(Room.l.hasThermostat, tstat, {
          properties: { installedBy: "tech-a" },
        })
    ).rejects.toThrow("does not define link properties")

    // Latest telemetry is part of effective object state, so appending a point also updates the
    // object it belongs to. The outbox is eventually dispatched and does not promise ordering
    // between independent commits, so this assertion waits for and compares the complete fact set.
    const stream = await waitFor(
      () => sixb.events.read(),
      (events) => events.length === 5
    )
    expect([...stream].map((event) => event.type).sort()).toEqual([
      "link.created",
      "object.created",
      "object.created",
      "object.updated",
      "telemetry.appended",
    ])
    expect(Object.fromEntries(stream.map((event) => [event.type, event.topic]))).toEqual({
      "object.created": "objects",
      "object.updated": "objects",
      "telemetry.appended": "telemetry",
      "link.created": "links",
    })

    const latest = await runtimeDeps.storage.timeseries.getLatest({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "currentTemperature",
    })

    expect(latest?.value).toBe(22.4)
    expect(latest?.unit).toBe("degreeCelsius")

    const projectedRoom = await runtimeDeps.storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })

    expect(projectedRoom?.properties.currentTemperature).toBe(22.4)

    const links = await runtimeDeps.storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      linkId: "hasThermostat",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.targetTypeId).toBe("Thermostat")
    expect(links[0]?.targetId).toBe("tstat:abc")
  })

  test("appendTelemetryBatch writes points for several objects in one call", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "batch-test",
      ontology: [Room, Thermostat],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:102", externalId: "RM-102", name: "Conference 102" },
    })

    const now = new Date("2026-03-01T12:00:00.000Z")

    await sixb.objects(Room).appendTelemetryBatch([
      {
        id: "room:101",
        properties: {
          currentTemperature: { value: 22.5, unit: "degreeCelsius" },
        },
        at: now,
      },
      {
        id: "room:102",
        properties: {
          currentTemperature: { value: 19.8, unit: "degreeCelsius" },
        },
        at: now,
      },
    ])

    // Verify timeseries storage
    const latest101 = await runtimeDeps.storage.timeseries.getLatest({
      projectId: "batch-test",
      objectTypeId: "Room",
      objectId: "room:101",
      propertyId: "currentTemperature",
    })
    expect(latest101?.value).toBe(22.5)
    expect(latest101?.unit).toBe("degreeCelsius")

    const latest102 = await runtimeDeps.storage.timeseries.getLatest({
      projectId: "batch-test",
      objectTypeId: "Room",
      objectId: "room:102",
      propertyId: "currentTemperature",
    })
    expect(latest102?.value).toBe(19.8)

    // Verify object storage projection
    const room101 = await runtimeDeps.storage.objects.getByPrimaryId({
      projectId: "batch-test",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(room101?.properties.currentTemperature).toBe(22.5)

    const room102 = await runtimeDeps.storage.objects.getByPrimaryId({
      projectId: "batch-test",
      objectTypeId: "Room",
      primaryId: "room:102",
    })
    expect(room102?.properties.currentTemperature).toBe(19.8)

    // Verify all telemetry events were written
    const events = await sixb.events.read({
      types: ["telemetry.appended"],
    })
    expect(events).toHaveLength(2)
  })

  test("appendTelemetryBatch validates all inputs before writing", async () => {
    const sixb = createTestSixb({
      id: "batch-validate-test",
      ontology: [Room],
      ...createTestRuntimeDeps(),
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    const valid = {
      id: "room:101",
      properties: { currentTemperature: { value: 22.5, unit: "degreeCelsius" as const } },
      at: new Date("2026-03-01T12:00:00.000Z"),
    }
    const rejection = (invalid: typeof valid) =>
      sixb
        .objects(Room)
        .appendTelemetryBatch([valid, invalid])
        .then(
          () => undefined,
          (error: unknown) => error
        )

    const missingObject = await rejection({ ...valid, id: "room:999" })
    expect(missingObject).toBeInstanceOf(ObjectNotFoundError)
    expect(missingObject).toMatchObject({ message: expect.stringContaining("Object not found") })

    // A later instant, so the invalid point does not replace the valid one inside the batch.
    const invalidUnit = await rejection({
      id: "room:101",
      properties: {
        currentTemperature: { value: 22.5, unit: "millibar" as unknown as "degreeCelsius" },
      },
      at: new Date("2026-03-01T12:01:00.000Z"),
    })
    expect(invalidUnit).toBeInstanceOf(MaterializationValidationError)
    expect(invalidUnit).toMatchObject({ message: expect.stringContaining("Invalid unit") })

    // Neither rejected batch wrote its valid entry.
    expect(
      await sixb.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).history()
    ).toEqual([])
  })

  test("removes links through the object handle and the id-based ObjectSet API", async () => {
    const sixb = createTestSixb({
      id: "unlink-test",
      ontology: [Room, Thermostat],
      ...createTestRuntimeDeps(),
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:101", externalId: "RM-101", name: "Conference 101" },
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:201", externalId: "RM-201", name: "Room 201" },
    })
    await sixb.objects(Thermostat).upsert({
      properties: { id: "tstat:abc", externalId: "device-123", name: "Tstat 101" },
    })
    const tstat = { objectTypeId: "Thermostat" as const, primaryId: "tstat:abc" }
    const handleLink = { room: sixb.objects(Room).byId("room:101"), link: Room.l.hasThermostat }
    const idLink = {
      sourceId: "room:201",
      linkId: "hasThermostat",
      targetTypeId: "Thermostat",
      targetId: "tstat:abc",
    }

    await handleLink.room.link(handleLink.link, tstat)
    await sixb.objects(Room).upsertLink(idLink)
    expect(await handleLink.room.listLinks(handleLink.link)).toHaveLength(1)
    expect(await sixb.objects(Room).byId("room:201").listLinks(handleLink.link)).toHaveLength(1)

    await handleLink.room.unlink(handleLink.link, tstat)
    await sixb.objects(Room).removeLink(idLink)

    expect(await handleLink.room.listLinks(handleLink.link)).toEqual([])
    expect(await sixb.objects(Room).byId("room:201").listLinks(handleLink.link)).toEqual([])
    await waitFor(
      () => sixb.events.read({ types: ["link.deleted"] }),
      (published) => published.length === 2
    )
  })

  test("rejects plain link id objects in listLinks", async () => {
    const sixb = createTestSixb({
      id: "list-links-token-test",
      ontology: [Room, Thermostat],
      ...createTestRuntimeDeps(),
    })

    await expect(
      sixb
        .objects(Room)
        .byId("room:101")
        .listLinks({ id: "hasThermostat" } as unknown as typeof Room.l.hasThermostat)
    ).rejects.toThrow("Expected a link token from Room.l.<linkId>")
  })

  test("requests action via ObjectByKeyHandle.requestAction", async () => {
    const ActionType = defineObjectType({
      id: "ActionDevice",
      name: "Action Device",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { required: true }),
      ],
    })
    const reboot = defineAction("reboot")
      .on(ActionType)
      .params({ force: optional(param("boolean")) })
      .writeback(async () => {})

    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "bykey-action-test",
      ontology: [ActionType],
      actions: [reboot],
      ...runtimeDeps,
    })

    await sixb.objects(ActionType).upsert({
      properties: { id: "dev:1", name: "Device 1" },
    })

    const run = await sixb
      .objects(ActionType)
      .byId("dev:1")
      .requestAction({
        actionId: "reboot",
        params: { force: true },
      })

    expect(run).toMatchObject({
      actionId: "reboot",
      status: "succeeded",
      subject: { kind: "object", objectTypeId: "ActionDevice", primaryId: "dev:1" },
      params: { force: true },
    })
  })

  describe("valueTypeRef validation", () => {
    const TemperatureReading = defineValueType({
      id: "bsh:TemperatureReading",
      name: "TemperatureReading",
      schema: {
        type: "object",
        properties: {
          value: { required: true, schema: "double" },
          unit: {
            required: true,
            schema: { type: "enum", valueType: "string", values: ["C", "F", "K"] },
          },
        },
      },
    })

    const Sensor = defineObjectType({
      id: "Sensor",
      name: "Sensor",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { required: true }),
        prop("reading", valueTypeRef(TemperatureReading)),
      ],
    })

    test("auto-discovers ValueTypes from ObjectType properties and enforces their schema", async () => {
      // Pass only the ObjectType — no explicit OntologyDocumentInput
      const sixb = createTestSixb({ ontology: [Sensor], ...createTestRuntimeDeps() })
      const upsertReading = (reading: unknown) =>
        sixb.objects.upsert("Sensor", { id: "sensor:1", name: "Temp-1", reading })

      expect((await upsertReading({ value: 22.5, unit: "C" })).properties.reading).toEqual({
        value: 22.5,
        unit: "C",
      })
      await expect(upsertReading({ value: "hot", unit: "C" })).rejects.toThrow("must be numeric")
      await expect(upsertReading({ value: 22.5, unit: "Rankine" })).rejects.toThrow(
        "must be one of"
      )
    })

    // Regression: auto-registration kept only `{ id, name, schema }`, so a value type defined
    // outside `ontology/` lost its semantic type and every unit was rejected. To check this guard,
    // drop the `semanticType` spread from `extractValueTypesFromSchema` in
    // `src/ontology/registry.ts`: the unit append fails with "cannot accept a unit" and the
    // unitless append resolves instead of rejecting.
    const AmbientTemperature = defineValueType({
      id: "lib:AmbientTemperature",
      name: "AmbientTemperature",
      schema: "double",
      semanticType: "Temperature",
    })
    const Probe = defineObjectType({
      id: "Probe",
      name: "Probe",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("ambient", valueTypeRef(AmbientTemperature), { mode: "telemetry" }),
      ],
    })

    test("keeps the semantic type of a value type registered only through its ref", async () => {
      const sixb = createTestSixb({ ontology: [Probe], ...createTestRuntimeDeps() })
      await sixb.objects(Probe).upsert({ properties: { id: "probe:1" } })
      const ambient = sixb.objects(Probe).byId("probe:1").telemetry(Probe.p.ambient)
      const at = new Date("2026-01-01T00:00:00Z")

      await ambient.append({ value: 21.5, unit: "degreeCelsius", at })
      expect(await ambient.history()).toEqual([{ value: 21.5, unit: "degreeCelsius", at }])

      // @ts-expect-error The referenced semantic type requires a unit.
      await expect(ambient.append({ value: 21.5, at })).rejects.toThrow(
        "Missing unit for telemetry property Probe.ambient"
      )
      await expect(
        ambient.append({ value: 21.5, unit: "millibar" as unknown as "degreeCelsius", at })
      ).rejects.toThrow("Invalid unit")
    })

    test("an explicitly registered value type overrides the semantic type on the ref", async () => {
      const Unitless = defineValueType({
        id: AmbientTemperature.id,
        name: "Unitless ambient",
        schema: "double",
      })
      const sixb = createTestSixb({
        ontology: [
          defineOntology({
            id: "explicit-value-type",
            version: "1.0.0",
            objectTypes: [Probe],
            valueTypes: [Unitless],
          }),
        ],
        ...createTestRuntimeDeps(),
      })
      await sixb.objects(Probe).upsert({ properties: { id: "probe:1" } })
      const ambient = sixb.objects(Probe).byId("probe:1").telemetry(Probe.p.ambient)
      const at = new Date("2026-01-01T00:00:00Z")

      // Types resolve value types through the generated registry, which does not see a value type
      // registered on this runtime only, so the channel is still typed from the ref.
      // @ts-expect-error The ref carries a semantic type, so its type requires a unit.
      await ambient.append({ value: 21.5, at })
      await expect(ambient.append({ value: 21.5, unit: "degreeCelsius", at })).rejects.toThrow(
        "cannot accept a unit"
      )
    })
  })
})

function countRead<T>(reads: Map<string, number>, field: string, value: T): T {
  reads.set(field, (reads.get(field) ?? 0) + 1)
  return value
}
