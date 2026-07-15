import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import {
  defineObjectType,
  link,
  type ObjectQuery,
  ObjectQueryExecutionError,
  OntologyRegistry,
  prop,
} from "@sixb/core"
import type {
  StoredLinkDeletedEvent,
  StoredLinkMutationEvent,
  StoredObjectMutationEvent,
  StoredTelemetryAppendedEvent,
} from "@sixb/core/internal/events"
import { executeObjectQuery } from "@sixb/core/internal/query"
import { migrateSqliteDatabase } from "../src/migrations"
import { SqliteObjectStorage } from "../src/object-storage"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      query: { searchable: true, text: true, filterable: true, exact: true, sortable: true },
    }),
    prop("floor", "string", {
      query: { searchable: true, filterable: true, exact: true, sortable: true },
    }),
    prop("capacity", "double", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("occupied", "boolean", {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop(
      "tags",
      { type: "array", items: "string" },
      {
        query: { searchable: true, filterable: true },
      }
    ),
    prop(
      "metadata",
      { type: "map", keySchema: "string", valueSchema: "string" },
      {
        query: { searchable: true, filterable: true },
      }
    ),
  ],
  search: { defaultText: ["name"] },
})

const Department = defineObjectType({
  id: "Department",
  name: "Department",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Employee = defineObjectType({
  id: "Employee",
  name: "Employee",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("department", Department, { cardinality: "one" })],
})

const Asset = defineObjectType({
  id: "Asset",
  name: "Asset",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Laptop = defineObjectType({
  id: "Laptop",
  name: "Laptop",
  extends: Asset,
  properties: [],
})

const ontology = new OntologyRegistry({ sources: [Room, Department, Employee, Asset, Laptop] })

describe("SqliteObjectStorage", () => {
  let storage: SqliteObjectStorage

  beforeEach(() => {
    storage = new SqliteObjectStorage() // in-memory mode
  })

  afterEach(() => {
    storage.close()
  })

  function createObjectEvent(
    projectId: string,
    objectTypeId: string,
    primaryId: string,
    properties: Record<string, unknown>,
    cursor: string
  ): StoredObjectMutationEvent {
    return {
      id: `event-${cursor}`,
      cursor,
      schemaVersion: 1,
      projectId,
      type: "object.created",
      topic: "objects",
      partitionKey: `${objectTypeId}:${primaryId}`,
      payload: { objectTypeId, primaryId, properties, propertyChanges: {} },
      occurredAt: new Date().toISOString(),
    }
  }

  function createTelemetryEvent(
    projectId: string,
    objectTypeId: string,
    objectId: string,
    propertyId: string,
    value: unknown,
    cursor: string
  ): StoredTelemetryAppendedEvent {
    return {
      id: `event-${cursor}`,
      cursor,
      schemaVersion: 1,
      projectId,
      type: "telemetry.appended",
      topic: "telemetry",
      partitionKey: `${objectTypeId}:${objectId}:${propertyId}`,
      payload: { objectTypeId, objectId, propertyId, value, at: new Date().toISOString() },
      occurredAt: new Date().toISOString(),
    }
  }

  function createLinkMutationEvent(
    projectId: string,
    sourceTypeId: string,
    sourceId: string,
    linkId: string,
    targetTypeId: string,
    targetId: string,
    cursor: string
  ): StoredLinkMutationEvent {
    return {
      id: `event-${cursor}`,
      cursor,
      schemaVersion: 1,
      projectId,
      type: "link.created",
      topic: "links",
      partitionKey: `${sourceTypeId}:${sourceId}:${linkId}`,
      payload: { sourceTypeId, sourceId, linkId, targetTypeId, targetId, propertyChanges: {} },
      occurredAt: new Date().toISOString(),
    }
  }

  function createLinkDeletedEvent(
    projectId: string,
    sourceTypeId: string,
    sourceId: string,
    linkId: string,
    targetTypeId: string,
    targetId: string,
    cursor: string
  ): StoredLinkDeletedEvent {
    return {
      id: `event-${cursor}`,
      cursor,
      schemaVersion: 1,
      projectId,
      type: "link.deleted",
      topic: "links",
      partitionKey: `${sourceTypeId}:${sourceId}:${linkId}`,
      payload: { sourceTypeId, sourceId, linkId, targetTypeId, targetId, propertyChanges: {} },
      occurredAt: new Date().toISOString(),
    }
  }

  test("queryCapabilities enables SQLite's native scalar query subset", () => {
    const capabilities = storage.queryCapabilities()

    expect(capabilities.queryObjects).toBe(true)
    expect(capabilities.countObjects).toBe(true)
    expect(capabilities.existsObjects).toBe(true)
    expect(capabilities.facetObjects).toBe(true)
    expect(capabilities.nodes?.start).toBe(true)
    expect(capabilities.nodes?.filter).toBe(true)
    expect(capabilities.nodes?.limit).toBe(true)
    expect(capabilities.nodes?.traverse).toBe(true)
    expect(capabilities.nodes?.set).toBe(true)
    expect(capabilities.nodes?.project).toBe(true)
    expect(capabilities.nodes?.text).toBe(true)
    expect(capabilities.predicateOps?.eq).toBe(true)
    expect(capabilities.predicateOps?.contains).toBe(true)
    expect(capabilities.sortKinds?.property).toBe(true)
    expect(capabilities.sortKinds?.relevance).toBeUndefined()
    expect(capabilities.traversalDirections?.incoming).toBe(true)
    expect(capabilities.traversalDirections?.outgoing).toBe(true)
    expect(capabilities.setOps?.union).toBe(true)
    expect(capabilities.setOps?.intersect).toBe(true)
    expect(capabilities.setOps?.subtract).toBe(true)
    expect(capabilities.features?.includeSubtypes).toBeUndefined()
    expect(capabilities.limits?.stablePageTokens).toBe(true)
  })

  test("queryObjects executes scalar filters, property sorting, and limit in SQLite", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:a",
        { id: "room:a", name: "Alpha", floor: "2", capacity: 10, occupied: true },
        "1"
      )
    )
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:b",
        { id: "room:b", name: "Beta", floor: "1", capacity: 30, occupied: false },
        "2"
      )
    )
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:c",
        { id: "room:c", name: "Gamma", floor: "2", capacity: 25, occupied: true },
        "3"
      )
    )
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:d",
        { id: "room:d", floor: "2", capacity: 50, occupied: true },
        "4"
      )
    )

    const result = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "limit",
        limit: 1,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "capacity", direction: "desc" }],
          input: {
            kind: "filter",
            predicate: {
              op: "and",
              items: [
                { op: "eq", propertyId: "floor", value: "2" },
                { op: "gte", propertyId: "capacity", value: 10 },
                { op: "eq", propertyId: "occupied", value: true },
                { op: "exists", propertyId: "name", value: true },
              ],
            },
            input: { kind: "start", objectTypeId: "Room" },
          },
        },
      },
    })

    expect(result.objects.map((row) => row.primaryId)).toEqual(["room:c"])
    expect(result.total).toBe(2)
    expect(result.hasMore).toBe(true)
  })

  test("queryObjects matches null, missing, neq, and in semantics", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:missing", { id: "room:missing" }, "1")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:null", { id: "room:null", floor: null }, "2")
    )
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:one",
        { id: "room:one", floor: "1", capacity: 10 },
        "3"
      )
    )
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:two",
        { id: "room:two", floor: "2", capacity: 20 },
        "4"
      )
    )

    const nullable = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "limit",
        limit: 10,
        input: {
          kind: "filter",
          predicate: {
            op: "or",
            items: [
              { op: "eq", propertyId: "floor", value: null },
              { op: "exists", propertyId: "floor", value: false },
            ],
          },
          input: { kind: "start", objectTypeId: "Room" },
        },
      },
    })
    const notOneOrTwo = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "limit",
        limit: 10,
        input: {
          kind: "filter",
          predicate: {
            op: "and",
            items: [
              { op: "neq", propertyId: "floor", value: "1" },
              { op: "in", propertyId: "floor", values: ["2", null] },
            ],
          },
          input: { kind: "start", objectTypeId: "Room" },
        },
      },
    })

    expect(new Set(nullable.objects.map((row) => row.primaryId))).toEqual(
      new Set(["room:missing", "room:null"])
    )
    expect(notOneOrTwo.objects.map((row) => row.primaryId)).toEqual(["room:null", "room:two"])
  })

  test("queryObjects treats empty in predicates as no matches", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:a", { id: "room:a", floor: "1" }, "1")
    )

    const result = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "filter",
        predicate: { op: "in", propertyId: "floor", values: [] },
        input: { kind: "start", objectTypeId: "Room" },
      },
    })

    expect(result.objects).toEqual([])
    expect(result.total).toBe(0)
  })

  test("queryObjects executes contains predicates in SQLite", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:a",
        {
          id: "room:a",
          name: "North Conference",
          tags: ["video", "training"],
          metadata: { wing: "north" },
        },
        "1"
      )
    )
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:b",
        { id: "room:b", name: "South Huddle", tags: ["focus"], metadata: { wing: "south" } },
        "2"
      )
    )

    const stringContains = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "filter",
        predicate: { op: "contains", propertyId: "name", value: "Conference" },
        input: { kind: "start", objectTypeId: "Room" },
      },
    })
    const arrayContains = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "filter",
        predicate: { op: "contains", propertyId: "tags", value: "focus" },
        input: { kind: "start", objectTypeId: "Room" },
      },
    })
    const mapContains = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "filter",
        predicate: { op: "contains", propertyId: "metadata", value: "wing" },
        input: { kind: "start", objectTypeId: "Room" },
      },
    })

    expect(stringContains.objects.map((row) => row.primaryId)).toEqual(["room:a"])
    expect(arrayContains.objects.map((row) => row.primaryId)).toEqual(["room:b"])
    expect(mapContains.objects.map((row) => row.primaryId)).toEqual(["room:a", "room:b"])
  })

  test("queryObjects executes basic text search in SQLite", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:a",
        { id: "room:a", name: "North Conference Room" },
        "1"
      )
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:b", { id: "room:b", name: "South Huddle" }, "2")
    )

    const result = await executeObjectQuery(
      {
        projectId: "project-a",
        query: {
          kind: "limit",
          limit: 10,
          input: {
            kind: "text",
            query: "north room",
            input: { kind: "start", objectTypeId: "Room" },
          },
        },
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    expect(result.objects.map((row) => row.primaryId)).toEqual(["room:a"])
  })

  test("queryObjects executes stable keyset page tokens", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:a", { id: "room:a" }, "1")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:b", { id: "room:b" }, "2")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:c", { id: "room:c" }, "3")
    )

    const page1 = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "page",
        pageSize: 2,
        input: { kind: "start", objectTypeId: "Room" },
      },
    })
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:aa", { id: "room:aa" }, "4")
    )
    const page2 = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "page",
        pageSize: 2,
        pageToken: page1.nextPageToken,
        input: { kind: "start", objectTypeId: "Room" },
      },
    })

    expect(page1.objects.map((row) => row.primaryId)).toEqual(["room:a", "room:b"])
    expect(page1.total).toBe(3)
    expect(page1.hasMore).toBe(true)
    expect(page1.nextPageToken?.startsWith("keyset:")).toBe(true)
    expect(page2.objects.map((row) => row.primaryId)).toEqual(["room:c"])
    expect(page2.hasMore).toBe(false)
    expect(page2.nextPageToken).toBeUndefined()
  })

  test("queryObjects executes keyset page tokens over property sorts", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:a", { id: "room:a", capacity: 10 }, "1")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:b", { id: "room:b", capacity: 30 }, "2")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:c", { id: "room:c", capacity: 20 }, "3")
    )

    const page1 = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "page",
        pageSize: 2,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "capacity", direction: "desc" }],
          input: { kind: "start", objectTypeId: "Room" },
        },
      },
    })
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:bb", { id: "room:bb", capacity: 25 }, "4")
    )
    const page2 = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "page",
        pageSize: 2,
        pageToken: page1.nextPageToken,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "capacity", direction: "desc" }],
          input: { kind: "start", objectTypeId: "Room" },
        },
      },
    })

    expect(page1.objects.map((row) => row.primaryId)).toEqual(["room:b", "room:c"])
    expect(page1.nextPageToken?.startsWith("keyset:")).toBe(true)
    expect(page2.objects.map((row) => row.primaryId)).toEqual(["room:a"])
    expect(page2.hasMore).toBe(false)
  })

  test("queryObjects preserves keyset page tokens through outer projection", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:a", { id: "room:a", capacity: 10 }, "1")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:b", { id: "room:b", capacity: 30 }, "2")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:c", { id: "room:c", capacity: 20 }, "3")
    )

    const queryInput: ObjectQuery = {
      kind: "sort",
      fields: [{ kind: "property", propertyId: "capacity", direction: "desc" }],
      input: { kind: "start", objectTypeId: "Room" },
    }
    const page1 = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "project",
        properties: ["id"],
        input: { kind: "page", pageSize: 2, input: queryInput },
      },
    })
    const page2 = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "project",
        properties: ["id"],
        input: { kind: "page", pageSize: 2, pageToken: page1.nextPageToken, input: queryInput },
      },
    })

    expect(page1.objects.map((row) => row.properties)).toEqual([{ id: "room:b" }, { id: "room:c" }])
    expect(page1.nextPageToken?.startsWith("keyset:")).toBe(true)
    expect(page2.objects.map((row) => row.primaryId)).toEqual(["room:a"])
  })

  test("queryObjects preserves hidden sort keys when paging projected rows", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:a", { id: "room:a", capacity: 10 }, "1")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:b", { id: "room:b", capacity: 30 }, "2")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:c", { id: "room:c", capacity: 20 }, "3")
    )

    const queryInput: ObjectQuery = {
      kind: "project",
      properties: ["id"],
      input: {
        kind: "sort",
        fields: [{ kind: "property", propertyId: "capacity", direction: "desc" }],
        input: { kind: "start", objectTypeId: "Room" },
      },
    }
    const page1 = await storage.queryObjects({
      projectId: "project-a",
      query: { kind: "page", pageSize: 2, input: queryInput },
    })
    const page2 = await storage.queryObjects({
      projectId: "project-a",
      query: { kind: "page", pageSize: 2, pageToken: page1.nextPageToken, input: queryInput },
    })

    expect(page1.objects.map((row) => row.properties)).toEqual([{ id: "room:b" }, { id: "room:c" }])
    expect(page1.hasMore).toBe(true)
    expect(page1.nextPageToken?.startsWith("keyset:")).toBe(true)
    expect(page2.objects.map((row) => row.properties)).toEqual([{ id: "room:a" }])
    expect(page2.hasMore).toBe(false)
  })

  test("queryObjects rejects mismatched page tokens as client input", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:a", { id: "room:a", capacity: 10 }, "1")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:b", { id: "room:b", capacity: 30 }, "2")
    )

    const page1 = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "page",
        pageSize: 1,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "capacity", direction: "desc" }],
          input: { kind: "start", objectTypeId: "Room" },
        },
      },
    })

    try {
      await storage.queryObjects({
        projectId: "project-a",
        query: {
          kind: "page",
          pageSize: 1,
          pageToken: page1.nextPageToken,
          input: {
            kind: "sort",
            fields: [{ kind: "property", propertyId: "capacity", direction: "asc" }],
            input: { kind: "start", objectTypeId: "Room" },
          },
        },
      })
      throw new Error("Expected mismatched page token to be rejected")
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectQueryExecutionError)
      if (error instanceof ObjectQueryExecutionError) {
        expect(error.code).toBe("invalid_page_token")
        expect(error.path).toBe("$.pageToken")
      }
    }
  })

  test("queryObjects executes set operations in SQLite", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:a",
        { id: "room:a", floor: "1", occupied: true },
        "1"
      )
    )
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:b",
        { id: "room:b", floor: "2", occupied: true },
        "2"
      )
    )
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:c",
        { id: "room:c", floor: "2", occupied: false },
        "3"
      )
    )

    const floorTwo: ObjectQuery = {
      kind: "filter",
      predicate: { op: "eq", propertyId: "floor", value: "2" },
      input: { kind: "start", objectTypeId: "Room" },
    }
    const occupied: ObjectQuery = {
      kind: "filter",
      predicate: { op: "eq", propertyId: "occupied", value: true },
      input: { kind: "start", objectTypeId: "Room" },
    }

    const union = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "limit",
        limit: 10,
        input: { kind: "set", op: "union", inputs: [floorTwo, occupied] },
      },
    })
    const intersect = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "limit",
        limit: 10,
        input: { kind: "set", op: "intersect", inputs: [floorTwo, occupied] },
      },
    })
    const subtract = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "limit",
        limit: 10,
        input: { kind: "set", op: "subtract", inputs: [floorTwo, occupied] },
      },
    })

    expect(union.objects.map((row) => row.primaryId)).toEqual(["room:a", "room:b", "room:c"])
    expect(intersect.objects.map((row) => row.primaryId)).toEqual(["room:b"])
    expect(subtract.objects.map((row) => row.primaryId)).toEqual(["room:c"])
  })

  test("queryObjects projects object properties in SQLite", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:a",
        { id: "room:a", name: "Alpha", floor: "1", capacity: 10 },
        "1"
      )
    )

    const result = await storage.queryObjects({
      projectId: "project-a",
      query: {
        kind: "project",
        properties: ["id", "name"],
        input: { kind: "start", objectTypeId: "Room" },
      },
    })

    expect(result.objects).toHaveLength(1)
    expect(result.objects[0].properties).toEqual({ id: "room:a", name: "Alpha" })
  })

  test("executeObjectQuery pushes down includeSubtypes starts as concrete unions", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Asset", "asset:a", { id: "asset:a" }, "1")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Laptop", "laptop:a", { id: "laptop:a" }, "2")
    )

    const result = await executeObjectQuery(
      {
        projectId: "project-a",
        query: {
          kind: "limit",
          limit: 10,
          input: { kind: "start", objectTypeId: "Asset", includeSubtypes: true },
        },
      },
      { ontology, storage, maxFallbackRows: 10 }
    )

    expect(result.plan.mode).toBe("pushdown")
    expect(new Set(result.objects.map((row) => row.primaryId))).toEqual(
      new Set(["asset:a", "laptop:a"])
    )
  })

  test("queryObjects traverses object links in SQLite", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Department", "dept-eng", { id: "dept-eng" }, "1")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Department", "dept-sales", { id: "dept-sales" }, "2")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Employee", "emp-alice", { id: "emp-alice" }, "3")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Employee", "emp-bob", { id: "emp-bob" }, "4")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Employee", "emp-clara", { id: "emp-clara" }, "5")
    )
    await storage.applyLinkUpsert(
      createLinkMutationEvent(
        "project-a",
        "Employee",
        "emp-alice",
        "department",
        "Department",
        "dept-eng",
        "6"
      )
    )
    await storage.applyLinkUpsert(
      createLinkMutationEvent(
        "project-a",
        "Employee",
        "emp-bob",
        "department",
        "Department",
        "dept-eng",
        "7"
      )
    )
    await storage.applyLinkUpsert(
      createLinkMutationEvent(
        "project-a",
        "Employee",
        "emp-clara",
        "department",
        "Department",
        "dept-sales",
        "8"
      )
    )

    const result = await executeObjectQuery(
      {
        projectId: "project-a",
        query: {
          kind: "limit",
          limit: 10,
          input: {
            kind: "traverse",
            direction: "incoming",
            linkId: "department",
            input: {
              kind: "filter",
              predicate: { op: "eq", propertyId: "id", value: "dept-eng" },
              input: { kind: "start", objectTypeId: "Department" },
            },
          },
        },
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    expect(result.objects.map((row) => row.primaryId)).toEqual(["emp-alice", "emp-bob"])
  })

  test("executeObjectQuery plans supported SQLite queries as pushdown", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:a",
        { id: "room:a", floor: "2", capacity: 10 },
        "1"
      )
    )
    await storage.applyObjectUpsert(
      createObjectEvent(
        "project-a",
        "Room",
        "room:b",
        { id: "room:b", floor: "2", capacity: 30 },
        "2"
      )
    )

    const query: ObjectQuery = {
      kind: "limit",
      limit: 5,
      input: {
        kind: "filter",
        predicate: { op: "eq", propertyId: "floor", value: "2" },
        input: { kind: "start", objectTypeId: "Room" },
      },
    }
    const result = await executeObjectQuery(
      { projectId: "project-a", query },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    expect(result.plan.providerIssues).toHaveLength(0)
    expect(result.objects.map((row) => row.primaryId)).toEqual(["room:a", "room:b"])
  })

  test("applyObjectUpsert creates new object", async () => {
    const event = createObjectEvent("project-a", "Room", "room:101", { name: "Conference" }, "1")
    const row = await storage.applyObjectUpsert(event)

    expect(row.primaryId).toBe("room:101")
    expect(row.objectTypeId).toBe("Room")
    expect(row.properties.name).toBe("Conference")
    expect(row.projectId).toBe("project-a")
    expect(row.version).toBe(1)
    expect(row.sourceEventId).toBe("event-1")
  })

  test("applyObjectUpsert merges properties", async () => {
    const event1 = createObjectEvent(
      "project-a",
      "Room",
      "room:101",
      { name: "Conference", floor: "2" },
      "1"
    )
    await storage.applyObjectUpsert(event1)

    const event2 = createObjectEvent("project-a", "Room", "room:101", { capacity: 20 }, "2")
    const row = await storage.applyObjectUpsert(event2)

    expect(row.properties.name).toBe("Conference")
    expect(row.properties.floor).toBe("2")
    expect(row.properties.capacity).toBe(20)
    expect(row.version).toBe(2)
  })

  test("applyObjectUpsert is idempotent", async () => {
    const event = createObjectEvent("project-a", "Room", "room:101", { name: "Conference" }, "1")

    await storage.applyObjectUpsert(event)
    await storage.applyObjectUpsert(event) // Same event ID

    const row = await storage.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(row?.version).toBe(1)
  })

  test("getByPrimaryId returns correct object", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", { name: "Room 1" }, "1")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:102", { name: "Room 2" }, "2")
    )
    await storage.applyObjectUpsert(
      createObjectEvent("project-b", "Room", "room:101", { name: "Room 3" }, "3")
    )

    const row = await storage.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })

    expect(row?.properties.name).toBe("Room 1")
  })

  test("getByPrimaryId returns null for non-existent object", async () => {
    const row = await storage.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:999",
    })
    expect(row).toBeNull()
  })

  test("applyTelemetryAppended updates object property", async () => {
    await storage.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", { name: "Conference" }, "1")
    )

    const telemetryEvent = createTelemetryEvent(
      "project-a",
      "Room",
      "room:101",
      "temperature",
      22.5,
      "2"
    )
    await storage.applyTelemetryAppended(telemetryEvent)

    const row = await storage.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(row?.properties.temperature).toBe(22.5)
    expect(row?.properties.name).toBe("Conference") // Original property preserved
    expect(row?.version).toBe(2)
  })

  test("applyTelemetryAppended is idempotent", async () => {
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:101", {}, "1"))

    const event = createTelemetryEvent("project-a", "Room", "room:101", "temperature", 22.5, "2")
    await storage.applyTelemetryAppended(event)
    await storage.applyTelemetryAppended(event) // Same event ID

    const row = await storage.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    expect(row?.version).toBe(2)
  })

  test("applyLinkUpsert creates link", async () => {
    const event = createLinkMutationEvent(
      "project-a",
      "Room",
      "room:101",
      "hasThermostat",
      "Thermostat",
      "tstat:abc",
      "1"
    )
    await storage.applyLinkUpsert(event)

    const links = await storage.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.linkId).toBe("hasThermostat")
    expect(links[0]?.targetTypeId).toBe("Thermostat")
    expect(links[0]?.targetId).toBe("tstat:abc")
  })

  test("applyLinkUpsert updates existing link", async () => {
    const event1 = createLinkMutationEvent(
      "project-a",
      "Room",
      "room:101",
      "hasThermostat",
      "Thermostat",
      "tstat:abc",
      "1"
    )
    await storage.applyLinkUpsert(event1)

    const event2 = createLinkMutationEvent(
      "project-a",
      "Room",
      "room:101",
      "hasThermostat",
      "Thermostat",
      "tstat:abc",
      "2"
    )
    await storage.applyLinkUpsert(event2)

    const links = await storage.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.sourceEventId).toBe("event-2")
  })

  test("applyLinkDelete removes link", async () => {
    await storage.applyLinkUpsert(
      createLinkMutationEvent(
        "project-a",
        "Room",
        "room:101",
        "hasThermostat",
        "Thermostat",
        "tstat:abc",
        "1"
      )
    )

    await storage.applyLinkDelete(
      createLinkDeletedEvent(
        "project-a",
        "Room",
        "room:101",
        "hasThermostat",
        "Thermostat",
        "tstat:abc",
        "2"
      )
    )

    const links = await storage.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
    })

    expect(links).toHaveLength(0)
  })

  test("listLinks filters by linkId", async () => {
    await storage.applyLinkUpsert(
      createLinkMutationEvent(
        "project-a",
        "Room",
        "room:101",
        "hasThermostat",
        "Thermostat",
        "tstat:1",
        "1"
      )
    )
    await storage.applyLinkUpsert(
      createLinkMutationEvent(
        "project-a",
        "Room",
        "room:101",
        "hasSensor",
        "Sensor",
        "sensor:1",
        "2"
      )
    )

    const links = await storage.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      linkId: "hasThermostat",
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.linkId).toBe("hasThermostat")
  })

  test("listLinks supports incoming and both directions", async () => {
    await storage.applyLinkUpsert(
      createLinkMutationEvent("project-a", "Room", "room:101", "hasSensor", "Sensor", "s1", "1")
    )
    await storage.applyLinkUpsert(
      createLinkMutationEvent("project-a", "Sensor", "s1", "installedIn", "Room", "room:101", "2")
    )

    const incoming = await storage.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      direction: "incoming",
    })
    const both = await storage.listLinks({
      projectId: "project-a",
      objectTypeId: "Room",
      objectId: "room:101",
      direction: "both",
    })

    expect(incoming.map((link) => link.linkId)).toEqual(["installedIn"])
    expect(both.map((link) => link.linkId).sort()).toEqual(["hasSensor", "installedIn"])
  })

  test("list returns objects with pagination", async () => {
    for (let i = 1; i <= 5; i++) {
      await storage.applyObjectUpsert(
        createObjectEvent("project-a", "Room", `room:10${i}`, { name: `Room ${i}` }, `${i}`)
      )
    }

    const result = await storage.list({
      projectId: "project-a",
      objectTypeId: "Room",
      limit: 2,
      offset: 0,
    })

    expect(result.objects).toHaveLength(2)
    expect(result.total).toBe(5)
    expect(result.hasMore).toBe(true)

    const countOnly = await storage.list({
      projectId: "project-a",
      objectTypeId: "Room",
      limit: 0,
    })
    expect(countOnly.objects).toHaveLength(0)
    expect(countOnly.total).toBe(5)
    expect(countOnly.hasMore).toBe(true)
  })

  test("list with primaryIdPrefix filter", async () => {
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:101", {}, "1"))
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:102", {}, "2"))
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "building:a", {}, "3"))

    const result = await storage.list({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryIdPrefix: "room:",
    })

    expect(result.objects).toHaveLength(2)
  })

  test("list with primaryIdSuffix filter", async () => {
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:101", {}, "1"))
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "zone:101", {}, "2"))
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:102", {}, "3"))

    const result = await storage.list({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryIdSuffix: "101",
    })

    expect(result.objects).toHaveLength(2)
  })

  test("list with time filters", async () => {
    const now = new Date()
    const past = new Date(now.getTime() - 10000)
    const future = new Date(now.getTime() + 10000)

    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:past", {}, "1"))
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:future", {}, "2"))

    const result = await storage.list({
      projectId: "project-a",
      objectTypeId: "Room",
      createdAfter: past,
      createdBefore: future,
    })

    expect(result.objects.length).toBeGreaterThanOrEqual(2)
  })

  test("list with ordering", async () => {
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:b", {}, "1"))
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:a", {}, "2"))
    await storage.applyObjectUpsert(createObjectEvent("project-a", "Room", "room:c", {}, "3"))

    const result = await storage.list({
      projectId: "project-a",
      objectTypeId: "Room",
      orderBy: "primaryId",
      order: "asc",
    })

    expect(result.objects[0]?.primaryId).toBe("room:a")
    expect(result.objects[1]?.primaryId).toBe("room:b")
    expect(result.objects[2]?.primaryId).toBe("room:c")
  })

  test("supports file persistence", async () => {
    const tempDir = `/tmp/test-storage-${Date.now()}`
    const tempFile = `${tempDir}/storage.sqlite`
    await migrateSqliteDatabase(tempFile)

    // Create and write
    const storage1 = new SqliteObjectStorage({ path: tempFile })
    await storage1.applyObjectUpsert(
      createObjectEvent("project-a", "Room", "room:101", { name: "Test Room" }, "1")
    )
    storage1.close()

    // Reopen and read
    const storage2 = new SqliteObjectStorage({ path: tempFile })
    const row = await storage2.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Room",
      primaryId: "room:101",
    })
    storage2.close()

    expect(row?.properties.name).toBe("Test Room")

    // Cleanup
    await rm(tempDir, { recursive: true, force: true })
  })

  // ── Batch methods ───────────────────────────────────────────

  test("applyObjectUpsertBatch — inserts multiple objects in one call", async () => {
    const events = [
      createObjectEvent("p1", "Room", "r1", { name: "Kitchen" }, "1"),
      createObjectEvent("p1", "Room", "r2", { name: "Bedroom" }, "2"),
      createObjectEvent("p1", "Room", "r3", { name: "Bathroom" }, "3"),
    ]

    const results = await storage.applyObjectUpsertBatch(events)

    expect(results).toHaveLength(3)
    expect(results[0].primaryId).toBe("r1")
    expect(results[1].primaryId).toBe("r2")
    expect(results[2].primaryId).toBe("r3")
    expect(results[0].properties.name).toBe("Kitchen")
  })

  test("applyObjectUpsertBatch — idempotent on replay", async () => {
    const events = [createObjectEvent("p1", "Room", "r1", { name: "Kitchen" }, "1")]

    await storage.applyObjectUpsertBatch(events)
    const results = await storage.applyObjectUpsertBatch(events)

    expect(results).toHaveLength(1)
    expect(results[0].primaryId).toBe("r1")
    expect(results[0].version).toBe(1)
  })

  test("applyLinkUpsertBatch — inserts multiple links in one call", async () => {
    await storage.applyObjectUpsert(createObjectEvent("p1", "Room", "r1", {}, "1"))
    await storage.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s1", {}, "2"))
    await storage.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s2", {}, "3"))

    const events = [
      createLinkMutationEvent("p1", "Room", "r1", "hasSensors", "Sensor", "s1", "4"),
      createLinkMutationEvent("p1", "Room", "r1", "hasSensors", "Sensor", "s2", "5"),
    ]

    await storage.applyLinkUpsertBatch(events)

    const links = await storage.listLinks({
      projectId: "p1",
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links).toHaveLength(2)
  })

  test("getByPrimaryIdBatch — returns found objects, omits missing", async () => {
    await storage.applyObjectUpsert(createObjectEvent("p1", "Room", "r1", { name: "A" }, "1"))
    await storage.applyObjectUpsert(createObjectEvent("p1", "Room", "r2", { name: "B" }, "2"))

    const result = await storage.getByPrimaryIdBatch({
      projectId: "p1",
      items: [
        { objectTypeId: "Room", primaryId: "r1" },
        { objectTypeId: "Room", primaryId: "r2" },
        { objectTypeId: "Room", primaryId: "missing" },
      ],
    })

    expect(result.size).toBe(2)
    expect(result.get("Room:r1")?.properties.name).toBe("A")
    expect(result.get("Room:r2")?.properties.name).toBe("B")
    expect(result.has("Room:missing")).toBe(false)
  })

  test("listLinksBatch — returns found links, omits missing", async () => {
    await storage.applyObjectUpsert(createObjectEvent("p1", "Room", "r1", {}, "1"))
    await storage.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s1", {}, "2"))
    await storage.applyLinkUpsert(
      createLinkMutationEvent("p1", "Room", "r1", "hasSensors", "Sensor", "s1", "3")
    )

    const result = await storage.listLinksBatch({
      projectId: "p1",
      items: [
        { objectTypeId: "Room", objectId: "r1", linkId: "hasSensors" },
        { objectTypeId: "Room", objectId: "r1", linkId: "noLinks" },
      ],
    })

    expect(result.size).toBe(1)
    expect(result.get("Room:r1:hasSensors")).toHaveLength(1)
    expect(result.has("Room:r1:noLinks")).toBe(false)
  })

  test("listIncidentLinksBatch — both directions, de-duplicated", async () => {
    await storage.applyObjectUpsert(createObjectEvent("p1", "Room", "r1", {}, "1"))
    await storage.applyObjectUpsert(createObjectEvent("p1", "Room", "r2", {}, "2"))
    await storage.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s1", {}, "3"))
    await storage.applyObjectUpsert(createObjectEvent("p1", "Sensor", "s2", {}, "4"))

    await storage.applyLinkUpsertBatch([
      // r1 as source
      createLinkMutationEvent("p1", "Room", "r1", "hasSensors", "Sensor", "s1", "5"),
      // r1 as target
      createLinkMutationEvent("p1", "Sensor", "s2", "installedIn", "Room", "r1", "6"),
      // incident to both listed objects (r1 source, r2 target)
      createLinkMutationEvent("p1", "Room", "r1", "relatedTo", "Room", "r2", "7"),
    ])

    const links = await storage.listIncidentLinksBatch({
      projectId: "p1",
      items: [
        { objectTypeId: "Room", objectId: "r1" },
        { objectTypeId: "Room", objectId: "r2" },
      ],
    })

    // hasSensors + installedIn + relatedTo. relatedTo is incident to both r1 and r2 but appears once.
    expect(links).toHaveLength(3)
    expect(links.filter((link) => link.linkId === "relatedTo")).toHaveLength(1)

    const empty = await storage.listIncidentLinksBatch({ projectId: "p1", items: [] })
    expect(empty).toHaveLength(0)
  })
})
