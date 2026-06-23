import { describe, expect, test } from "bun:test"
import type { StoredLinkUpsertedEvent, StoredObjectUpsertedEvent } from "../events"
import {
  collectObjectQueryValidationIssues,
  countObjects,
  executeObjectQuery,
  existsObjects,
  facetObjects,
  normalizeObjectQuery,
  type ObjectQuery,
  ObjectQueryPlanningError,
  validateObjectQuery,
} from "../objects/query"
import { defineObjectType, link, OntologyRegistry, prop, stringEnum } from "../ontology"
import type { ObjectStorage, QueryObjectsResult } from "../storage/objects"

export interface ObjectQueryProviderContractSuiteOptions<TStorage extends ObjectStorage> {
  /** Factory that produces a fresh object storage instance for each test case. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Optional cleanup invoked after every test case. */
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "object-query-contract"

const Device = defineObjectType({
  id: "ContractDevice",
  name: "Contract Device",
  properties: [
    prop("id", "string", {
      required: true,
      primary: true,
      query: { searchable: true, filterable: true, exact: true, sortable: true },
    }),
    prop("name", "string", {
      query: { searchable: true, text: true, filterable: true, exact: true, sortable: true },
    }),
  ],
  search: { defaultText: ["name"] },
})

const Room = defineObjectType({
  id: "ContractRoom",
  name: "Contract Room",
  properties: [
    prop("id", "string", {
      required: true,
      primary: true,
      query: { searchable: true, filterable: true, exact: true, sortable: true },
    }),
    prop("name", "string", {
      query: { searchable: true, text: true, filterable: true, exact: true, sortable: true },
    }),
    prop("description", "string", {
      query: { searchable: true, text: true },
    }),
    prop("floor", "string", {
      nullable: true,
      query: { searchable: true, filterable: true, exact: true, sortable: true },
    }),
    prop("capacity", "double", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("occupied", "boolean", {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("status", stringEnum(["active", "paused"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop(
      "tags",
      { type: "array", items: "string" },
      { query: { searchable: true, filterable: true } }
    ),
    prop(
      "metadata",
      { type: "map", keySchema: "string", valueSchema: "string" },
      { query: { searchable: true, filterable: true } }
    ),
    prop(
      "embedding",
      { type: "array", items: "double" },
      { query: { searchable: true, vector: true } }
    ),
  ],
  links: [link("hasDevice", Device)],
  search: {
    defaultText: ["name", "description"],
    vector: { property: "embedding", source: ["name", "description"] },
  },
})

const Zone = defineObjectType({
  id: "ContractZone",
  name: "Contract Zone",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("hasDevice", Device)],
})

const Asset = defineObjectType({
  id: "ContractAsset",
  name: "Contract Asset",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const LaptopAsset = defineObjectType({
  id: "ContractLaptopAsset",
  name: "Contract Laptop Asset",
  extends: Asset,
  properties: [],
})

const DefaultTextBase = defineObjectType({
  id: "ContractDefaultTextBase",
  name: "Contract Default Text Base",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { query: { searchable: true, text: true } }),
    prop("alias", "string"),
  ],
  search: { defaultText: ["name"] },
})

const DefaultTextChild = defineObjectType({
  id: "ContractDefaultTextChild",
  name: "Contract Default Text Child",
  extends: DefaultTextBase,
  properties: [prop("alias", "string", { query: { searchable: true, text: true } })],
  search: { defaultText: ["alias"] },
})

export const objectQueryContractOntology = new OntologyRegistry({
  sources: [Room, Device, Zone, Asset, LaptopAsset, DefaultTextBase, DefaultTextChild],
})

/**
 * Runs the shared object-query provider contract against any ObjectStorage.
 *
 * The contract defines the portable V1 query surface: capability declarations,
 * validation/normalization handoff, provider pushdown, bounded fallback,
 * traversal, set operations, pagination, search profile defaults, and stable
 * structured rejections for features outside a provider's capability map.
 */
export function runObjectQueryProviderContractSuite<TStorage extends ObjectStorage>(
  label: string,
  options: ObjectQueryProviderContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    test("normalizes query shape and resolves search profile defaults", () => {
      const normalized = normalizeObjectQuery({
        kind: "limit",
        limit: 10,
        input: {
          kind: "limit",
          limit: 3,
          input: {
            kind: "project",
            properties: ["id", "name", "id"],
            input: {
              kind: "text",
              query: "alpha",
              fields: ["name", "description", "name"],
              input: { kind: "start", objectTypeId: Room.id },
            },
          },
        },
      })

      expect(normalized.kind).toBe("limit")
      if (normalized.kind !== "limit") return
      expect(normalized.limit).toBe(3)
      expect(normalized.input.kind).toBe("project")
      if (normalized.input.kind !== "project") return
      expect(normalized.input.properties).toEqual(["id", "name"])
      expect(normalized.input.input.kind).toBe("text")
      if (normalized.input.input.kind !== "text") return
      expect(normalized.input.input.fields).toEqual(["name", "description"])

      const validated = validateObjectQuery(
        { kind: "text", query: "alpha", input: { kind: "start", objectTypeId: Room.id } },
        { ontology: objectQueryContractOntology }
      )
      expect(validated.query.kind).toBe("text")
      if (validated.query.kind === "text") {
        expect(validated.query.fields).toBeUndefined()
        expect(validated.query.fieldsByObjectType).toEqual({
          [Room.id]: ["name", "description"],
        })
      }
    })

    test("collects validation failures before provider planning", () => {
      const issues = collectObjectQueryValidationIssues(
        {
          kind: "filter",
          predicate: { op: "eq", propertyId: "missing", value: "x" },
          input: {
            kind: "text",
            query: "alpha",
            fields: ["capacity"],
            input: { kind: "start", objectTypeId: Room.id },
          },
        },
        { ontology: objectQueryContractOntology }
      )

      expect(issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "unknown_property",
          "query_field_not_enabled",
          "text_field_not_string_like",
        ])
      )
    })

    test("declares the portable V1 query capability surface", async () => {
      await withStorage(async (storage) => {
        const capabilities = storage.queryCapabilities()

        expect(capabilities.queryObjects).toBe(true)
        expect(capabilities.countObjects).toBe(true)
        expect(capabilities.existsObjects).toBe(true)
        expect(capabilities.facetObjects).toBe(true)
        for (const node of [
          "start",
          "filter",
          "text",
          "sort",
          "limit",
          "page",
          "traverse",
          "set",
          "project",
        ] as const) {
          expect(capabilities.nodes?.[node]).toBe(true)
        }
        for (const op of [
          "and",
          "or",
          "not",
          "eq",
          "neq",
          "lt",
          "lte",
          "gt",
          "gte",
          "in",
          "exists",
          "contains",
        ] as const) {
          expect(capabilities.predicateOps?.[op]).toBe(true)
        }
        expect(capabilities.sortKinds?.property).toBe(true)
        expect(capabilities.traversalDirections?.outgoing).toBe(true)
        expect(capabilities.traversalDirections?.incoming).toBe(true)
        expect(capabilities.setOps?.union).toBe(true)
        expect(capabilities.setOps?.intersect).toBe(true)
        expect(capabilities.setOps?.subtract).toBe(true)
      })
    })

    test("pushes down scalar predicates, boolean groups, sorting, limits, and projections", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const result = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "project",
              properties: ["id", "name", "capacity"],
              input: {
                kind: "limit",
                limit: 2,
                input: {
                  kind: "sort",
                  fields: [{ kind: "property", propertyId: "capacity", direction: "desc" }],
                  input: {
                    kind: "filter",
                    predicate: {
                      op: "and",
                      items: [
                        { op: "eq", propertyId: "status", value: "active" },
                        { op: "neq", propertyId: "name", value: "Gamma Huddle" },
                        { op: "gte", propertyId: "capacity", value: 10 },
                        { op: "lte", propertyId: "capacity", value: 30 },
                        { op: "in", propertyId: "floor", values: ["2"] },
                        { op: "contains", propertyId: "tags", value: "lab" },
                        {
                          op: "or",
                          items: [
                            { op: "contains", propertyId: "name", value: "Alpha" },
                            { op: "contains", propertyId: "metadata", value: "wing" },
                          ],
                        },
                        { op: "not", item: { op: "eq", propertyId: "id", value: "missing" } },
                      ],
                    },
                    input: { kind: "start", objectTypeId: Room.id },
                  },
                },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(result.plan.mode).toBe("pushdown")
        expect(ids(result)).toEqual(["room-beta", "room-alpha"])
        expect(result.objects[0]?.properties).toEqual({
          id: "room-beta",
          name: "Beta Lab",
          capacity: 30,
        })
        expect(result.total).toBe(2)
        expect(result.hasMore).toBe(false)
      })
    })

    test("matches null, missing, neq, in, and not predicate semantics", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const nullable = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "sort",
              fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
              input: {
                kind: "filter",
                predicate: {
                  op: "or",
                  items: [
                    { op: "eq", propertyId: "floor", value: null },
                    { op: "exists", propertyId: "floor", value: false },
                  ],
                },
                input: { kind: "start", objectTypeId: Room.id },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const notTwoOrNull = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "sort",
              fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
              input: {
                kind: "filter",
                predicate: {
                  op: "and",
                  items: [
                    { op: "neq", propertyId: "floor", value: "2" },
                    { op: "in", propertyId: "floor", values: ["1", null] },
                  ],
                },
                input: { kind: "start", objectTypeId: Room.id },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const notNullFloor = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "sort",
              fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
              input: {
                kind: "filter",
                predicate: { op: "neq", propertyId: "floor", value: null },
                input: { kind: "start", objectTypeId: Room.id },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const notFloorTwo = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "sort",
              fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
              input: {
                kind: "filter",
                predicate: { op: "not", item: { op: "eq", propertyId: "floor", value: "2" } },
                input: { kind: "start", objectTypeId: Room.id },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(ids(nullable)).toEqual(["room-missing-floor", "room-null-floor"])
        expect(ids(notTwoOrNull)).toEqual(["room-gamma", "room-null-floor"])
        expect(ids(notNullFloor)).toEqual([
          "room-alpha",
          "room-beta",
          "room-gamma",
          "room-missing-floor",
        ])
        expect(ids(notFloorTwo)).toEqual(["room-gamma", "room-missing-floor", "room-null-floor"])
      })
    })

    test("keeps page tokens stable when projection hides sorted cursor fields", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const input: ObjectQuery = {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "capacity", direction: "desc" }],
          input: {
            kind: "filter",
            predicate: { op: "exists", propertyId: "capacity", value: true },
            input: { kind: "start", objectTypeId: Room.id },
          },
        }
        const page1 = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "project",
              properties: ["id"],
              input: { kind: "page", pageSize: 2, input },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const page2 = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "project",
              properties: ["id"],
              input: { kind: "page", pageSize: 2, pageToken: page1.nextPageToken, input },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(page1.plan.mode).toBe("pushdown")
        expect(ids(page1)).toEqual(["room-beta", "room-gamma"])
        expect(page1.objects.map((row) => row.properties)).toEqual([
          { id: "room-beta" },
          { id: "room-gamma" },
        ])
        expect(page1.hasMore).toBe(true)
        expect(page1.nextPageToken).toBeTruthy()
        expect(ids(page2)).toEqual(["room-alpha"])
      })
    })

    test("omits totals when requested without losing hasMore", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const limited = await executeObjectQuery(
          {
            projectId,
            includeTotal: false,
            query: { kind: "limit", limit: 2, input: { kind: "start", objectTypeId: Room.id } },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const page = await executeObjectQuery(
          {
            projectId,
            includeTotal: false,
            query: { kind: "page", pageSize: 2, input: { kind: "start", objectTypeId: Room.id } },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const sortedLimited = await executeObjectQuery(
          {
            projectId,
            includeTotal: false,
            query: {
              kind: "sort",
              fields: [{ kind: "property", propertyId: "capacity", direction: "desc" }],
              input: { kind: "limit", limit: 2, input: { kind: "start", objectTypeId: Room.id } },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(limited.plan.mode).toBe("pushdown")
        expect(ids(limited)).toEqual(["room-alpha", "room-beta"])
        expect(limited.total).toBeUndefined()
        expect(limited.hasMore).toBe(true)
        expect(ids(page)).toEqual(["room-alpha", "room-beta"])
        expect(page.total).toBeUndefined()
        expect(page.hasMore).toBe(true)
        expect(page.nextPageToken).toBeTruthy()
        expect(ids(sortedLimited)).toEqual(["room-beta", "room-alpha"])
        expect(sortedLimited.total).toBeUndefined()
        expect(sortedLimited.hasMore).toBe(true)
      })
    })

    test("counts matching objects without returning rows", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const active = await countObjects(
          {
            projectId,
            query: {
              kind: "filter",
              predicate: { op: "eq", propertyId: "status", value: "active" },
              input: { kind: "start", objectTypeId: Room.id },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const limited = await countObjects(
          {
            projectId,
            query: { kind: "limit", limit: 2, input: { kind: "start", objectTypeId: Room.id } },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(active.plan.mode).toBe("pushdown")
        expect(active.count).toBe(2)
        expect(limited.count).toBe(5)
      })
    })

    test("checks existence without returning rows", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const active = await existsObjects(
          {
            projectId,
            query: {
              kind: "filter",
              predicate: { op: "eq", propertyId: "status", value: "active" },
              input: { kind: "start", objectTypeId: Room.id },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const missing = await existsObjects(
          {
            projectId,
            query: {
              kind: "filter",
              predicate: { op: "eq", propertyId: "name", value: "No Such Room" },
              input: { kind: "start", objectTypeId: Room.id },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const limited = await existsObjects(
          {
            projectId,
            query: { kind: "limit", limit: 0, input: { kind: "start", objectTypeId: Room.id } },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(active.plan.mode).toBe("pushdown")
        expect(active.exists).toBe(true)
        expect(missing.exists).toBe(false)
        expect(limited.exists).toBe(true)
      })
    })

    test("plans aggregate operations without outer row-shaping requirements", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)
        const query: ObjectQuery = {
          kind: "sort",
          fields: [{ kind: "relevance" }],
          input: {
            kind: "text",
            query: "alpha",
            input: { kind: "start", objectTypeId: Room.id },
          },
        }

        const count = await countObjects(
          { projectId, query },
          { ontology: objectQueryContractOntology, storage }
        )
        const exists = await existsObjects(
          { projectId, query },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(count.plan.mode).toBe("pushdown")
        if (count.plan.mode !== "pushdown") return
        expect(count.plan.query.kind).toBe("text")
        expect(count.count).toBe(1)
        expect(exists.plan.mode).toBe("pushdown")
        if (exists.plan.mode !== "pushdown") return
        expect(exists.plan.query.kind).toBe("text")
        expect(exists.exists).toBe(true)
      })
    })

    test("counts matching objects by facetable properties without returning rows", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const status = await facetObjects(
          {
            projectId,
            query: { kind: "start", objectTypeId: Room.id },
            facets: [
              { propertyId: "status", limit: 10 },
              { propertyId: "occupied", limit: 10 },
            ],
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const limited = await facetObjects(
          {
            projectId,
            query: { kind: "limit", limit: 0, input: { kind: "start", objectTypeId: Room.id } },
            facets: [
              { propertyId: "status", limit: 10 },
              { propertyId: "occupied", limit: 10 },
            ],
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(status.plan.mode).toBe("pushdown")
        expect(status.facets).toEqual([
          {
            propertyId: "status",
            buckets: [
              { value: "paused", count: 3 },
              { value: "active", count: 2 },
            ],
          },
          {
            propertyId: "occupied",
            buckets: [
              { value: false, count: 3 },
              { value: true, count: 2 },
            ],
          },
        ])
        expect(limited.facets).toEqual(status.facets)
      })
    })

    test("pushes down traversal and set operations", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const outgoing = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "traverse",
              direction: "outgoing",
              linkId: "hasDevice",
              input: {
                kind: "filter",
                predicate: { op: "eq", propertyId: "status", value: "active" },
                input: { kind: "start", objectTypeId: Room.id },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const incoming = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "traverse",
              direction: "incoming",
              linkId: "hasDevice",
              input: { kind: "start", objectTypeId: Device.id },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const incomingRooms = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "traverse",
              direction: "incoming",
              linkId: "hasDevice",
              sourceObjectTypeId: Room.id,
              input: { kind: "start", objectTypeId: Device.id },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const incomingZones = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "traverse",
              direction: "incoming",
              linkId: "hasDevice",
              sourceObjectTypeId: Zone.id,
              input: { kind: "start", objectTypeId: Device.id },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const intersect = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "set",
              op: "intersect",
              inputs: [
                {
                  kind: "filter",
                  predicate: { op: "eq", propertyId: "status", value: "active" },
                  input: { kind: "start", objectTypeId: Room.id },
                },
                {
                  kind: "filter",
                  predicate: { op: "contains", propertyId: "tags", value: "lab" },
                  input: { kind: "start", objectTypeId: Room.id },
                },
              ],
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )
        const subtract = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "set",
              op: "subtract",
              inputs: [
                {
                  kind: "filter",
                  predicate: { op: "eq", propertyId: "status", value: "active" },
                  input: { kind: "start", objectTypeId: Room.id },
                },
                {
                  kind: "filter",
                  predicate: { op: "contains", propertyId: "name", value: "Alpha" },
                  input: { kind: "start", objectTypeId: Room.id },
                },
              ],
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(outgoing.plan.mode).toBe("pushdown")
        expect(incoming.plan.mode).toBe("pushdown")
        expect(sortedIds(outgoing)).toEqual(["device-projector", "device-sensor"])
        expect(sortedIds(incoming)).toEqual(["room-alpha", "room-beta", "zone-one"])
        expect(incomingRooms.plan.mode).toBe("pushdown")
        expect(sortedIds(incomingRooms)).toEqual(["room-alpha", "room-beta"])
        expect(sortedIds(incomingZones)).toEqual(["zone-one"])
        expect(sortedIds(intersect)).toEqual(["room-alpha", "room-beta"])
        expect(ids(subtract)).toEqual(["room-beta"])
      })
    })

    test("hydrates expand links through bounded fallback", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const outgoing = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "expand",
              expansions: [{ linkId: "hasDevice", direction: "outgoing" }],
              input: {
                kind: "limit",
                limit: 10,
                input: {
                  kind: "filter",
                  predicate: { op: "eq", propertyId: "status", value: "active" },
                  input: { kind: "start", objectTypeId: Room.id },
                },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        // No provider declares expand pushdown yet, so it routes through fallback.
        expect(outgoing.plan.mode).toBe("fallback")
        expect(expandedIds(outgoing, "room-alpha", "hasDevice")).toEqual(["device-projector"])
        expect(expandedIds(outgoing, "room-beta", "hasDevice")).toEqual(["device-sensor"])

        const incoming = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "expand",
              expansions: [{ linkId: "hasDevice", direction: "incoming" }],
              input: {
                kind: "limit",
                limit: 10,
                input: { kind: "start", objectTypeId: Device.id },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        // device-projector is linked from both a Room and a Zone.
        expect(expandedIds(incoming, "device-projector", "hasDevice")).toEqual([
          "room-alpha",
          "zone-one",
        ])
        expect(expandedIds(incoming, "device-sensor", "hasDevice")).toEqual(["room-beta"])
      })
    })

    test("expands includeSubtypes outside storage when the expanded query can push down", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const result = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "limit",
              limit: 10,
              input: { kind: "start", objectTypeId: Asset.id, includeSubtypes: true },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(result.plan.mode).toBe("pushdown")
        expect(sortedIds(result)).toEqual(["asset-base", "laptop-1"])
      })
    })

    test("pushes down basic text search using search profile defaults", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)

        const result = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "sort",
              fields: [{ kind: "property", propertyId: "name", direction: "asc" }],
              input: {
                kind: "text",
                query: "alpha collaboration",
                input: { kind: "start", objectTypeId: Room.id },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(result.plan.mode).toBe("pushdown")
        expect(ids(result)).toEqual(["room-alpha"])
      })
    })

    test("scopes search profile defaults by object type for subtype text queries", async () => {
      await withStorage(async (storage) => {
        await storage.applyObjectUpserted(
          objectEvent("101", DefaultTextBase.id, "default-base", {
            id: "default-base",
            name: "ordinary",
            alias: "secret",
          })
        )
        await storage.applyObjectUpserted(
          objectEvent("102", DefaultTextChild.id, "default-child", {
            id: "default-child",
            name: "ordinary",
            alias: "secret",
          })
        )

        const result = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "text",
              query: "secret",
              input: {
                kind: "start",
                objectTypeId: DefaultTextBase.id,
                includeSubtypes: true,
              },
            },
          },
          { ontology: objectQueryContractOntology, storage }
        )

        expect(ids(result)).toEqual(["default-child"])
      })
    })

    test("executes or rejects relevance sorting according to provider capabilities", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)
        const query: ObjectQuery = {
          kind: "sort",
          fields: [{ kind: "relevance" }],
          input: {
            kind: "text",
            query: "alpha",
            input: { kind: "start", objectTypeId: Room.id },
          },
        }

        if (storage.queryCapabilities().sortKinds?.relevance === true) {
          const result = await executeObjectQuery(
            { projectId, query },
            { ontology: objectQueryContractOntology, storage }
          )
          expect(result.plan.mode).toBe("pushdown")
          expect(ids(result)).toEqual(["room-alpha"])
          return
        }

        await expectPlanningIssue(
          executeObjectQuery(
            { projectId, query },
            { ontology: objectQueryContractOntology, storage }
          ),
          "sort_kind_not_supported"
        )
      })
    })

    test("executes or rejects vector search according to provider capabilities", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)
        const query: ObjectQuery = {
          kind: "vector",
          propertyId: "embedding",
          vector: [1, 0],
          k: 2,
          input: { kind: "start", objectTypeId: Room.id },
        }

        if (storage.queryCapabilities().nodes?.vector === true) {
          const result = await executeObjectQuery(
            { projectId, query },
            { ontology: objectQueryContractOntology, storage }
          )
          expect(result.plan.mode).toBe("pushdown")
          expect(ids(result)).toEqual(["room-alpha", "room-beta"])
          return
        }

        await expectPlanningIssue(
          executeObjectQuery(
            { projectId, query },
            { ontology: objectQueryContractOntology, storage }
          ),
          "query_node_not_supported"
        )
      })
    })

    test("executes bounded fallback when pushdown is disabled for a safe query", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)
        const fallbackStorage = withoutQueryPushdown(storage)

        const result = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "limit",
              limit: 2,
              input: {
                kind: "sort",
                fields: [{ kind: "property", propertyId: "name", direction: "asc" }],
                input: {
                  kind: "filter",
                  predicate: { op: "eq", propertyId: "status", value: "active" },
                  input: { kind: "start", objectTypeId: Room.id },
                },
              },
            },
          },
          { ontology: objectQueryContractOntology, storage: fallbackStorage, maxFallbackRows: 20 }
        )

        expect(result.plan.mode).toBe("fallback")
        expect(ids(result)).toEqual(["room-alpha", "room-beta"])
      })
    })

    test("rejects fallback for unsupported query nodes when pushdown is disabled", async () => {
      await withStorage(async (storage) => {
        await seedObjectQueryContractData(storage)
        const fallbackStorage = withoutQueryPushdown(storage)

        await expectPlanningIssue(
          executeObjectQuery(
            {
              projectId,
              query: {
                kind: "limit",
                limit: 5,
                input: {
                  kind: "traverse",
                  direction: "outgoing",
                  linkId: "hasDevice",
                  input: { kind: "start", objectTypeId: Room.id },
                },
              },
            },
            { ontology: objectQueryContractOntology, storage: fallbackStorage, maxFallbackRows: 20 }
          ),
          "fallback_node_not_supported"
        )
      })
    })
  })
}

export async function seedObjectQueryContractData(storage: ObjectStorage): Promise<void> {
  await storage.applyObjectUpserted(
    objectEvent("001", Room.id, "room-alpha", {
      id: "room-alpha",
      name: "Alpha Conference",
      description: "north alpha collaboration",
      floor: "2",
      capacity: 10,
      occupied: true,
      status: "active",
      tags: ["lab", "video"],
      metadata: { wing: "north" },
      embedding: [1, 0],
    })
  )
  await storage.applyObjectUpserted(
    objectEvent("002", Room.id, "room-beta", {
      id: "room-beta",
      name: "Beta Lab",
      description: "south beta focus",
      floor: "2",
      capacity: 30,
      occupied: false,
      status: "active",
      tags: ["lab"],
      metadata: { wing: "south" },
      embedding: [0.8, 0.2],
    })
  )
  await storage.applyObjectUpserted(
    objectEvent("003", Room.id, "room-gamma", {
      id: "room-gamma",
      name: "Gamma Huddle",
      description: "quiet office",
      floor: "1",
      capacity: 20,
      occupied: true,
      status: "paused",
      tags: ["office"],
      metadata: { zone: "quiet" },
      embedding: [0, 1],
    })
  )
  await storage.applyObjectUpserted(
    objectEvent("004", Room.id, "room-null-floor", {
      id: "room-null-floor",
      name: "Null Floor",
      description: "nullable floor fixture",
      floor: null,
      occupied: false,
      status: "paused",
      tags: [],
      metadata: {},
      embedding: [0, 0],
    })
  )
  await storage.applyObjectUpserted(
    objectEvent("005", Room.id, "room-missing-floor", {
      id: "room-missing-floor",
      name: "Missing Floor",
      description: "missing floor fixture",
      occupied: false,
      status: "paused",
      tags: [],
      metadata: {},
      embedding: [0, 0],
    })
  )
  await storage.applyObjectUpserted(
    objectEvent("006", Device.id, "device-projector", {
      id: "device-projector",
      name: "Projector",
    })
  )
  await storage.applyObjectUpserted(
    objectEvent("007", Device.id, "device-sensor", {
      id: "device-sensor",
      name: "Sensor",
    })
  )
  await storage.applyObjectUpserted(
    objectEvent("008", Asset.id, "asset-base", {
      id: "asset-base",
    })
  )
  await storage.applyObjectUpserted(
    objectEvent("009", LaptopAsset.id, "laptop-1", {
      id: "laptop-1",
    })
  )
  await storage.applyLinkUpserted(
    linkEvent("010", Room.id, "room-alpha", "hasDevice", Device.id, "device-projector")
  )
  await storage.applyLinkUpserted(
    linkEvent("011", Room.id, "room-beta", "hasDevice", Device.id, "device-sensor")
  )
  await storage.applyObjectUpserted(objectEvent("103", Zone.id, "zone-one", { id: "zone-one" }))
  await storage.applyLinkUpserted(
    linkEvent("012", Zone.id, "zone-one", "hasDevice", Device.id, "device-projector")
  )
}

function objectEvent(
  cursor: string,
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, unknown>
): StoredObjectUpsertedEvent {
  return {
    id: `object-query-contract-object-${cursor}`,
    cursor,
    schemaVersion: 1,
    projectId,
    type: "object.upserted",
    topic: "objects",
    partitionKey: `${objectTypeId}:${primaryId}`,
    payload: { objectTypeId, primaryId, properties },
    occurredAt: `2026-01-01T00:00:${cursor.slice(-2)}.000Z`,
  }
}

function linkEvent(
  cursor: string,
  sourceTypeId: string,
  sourceId: string,
  linkId: string,
  targetTypeId: string,
  targetId: string
): StoredLinkUpsertedEvent {
  return {
    id: `object-query-contract-link-${cursor}`,
    cursor,
    schemaVersion: 1,
    projectId,
    type: "link.upserted",
    topic: "links",
    partitionKey: `${sourceTypeId}:${sourceId}:${linkId}`,
    payload: { sourceTypeId, sourceId, linkId, targetTypeId, targetId },
    occurredAt: `2026-01-01T00:00:${cursor.slice(-2)}.000Z`,
  }
}

function ids(result: QueryObjectsResult): string[] {
  return result.objects.map((row) => row.primaryId)
}

// Sorted primaryIds of the objects hydrated under `linkId` on the parent row.
function expandedIds(result: QueryObjectsResult, parentId: string, linkId: string): string[] {
  const parent = result.objects.find((row) => row.primaryId === parentId)
  if (!parent) throw new Error(`parent row '${parentId}' not found`)
  const value = parent.links?.[linkId]
  if (!Array.isArray(value)) throw new Error(`expected an array of links under '${linkId}'`)
  return value.map((linked) => linked.primaryId).sort()
}

function sortedIds(result: QueryObjectsResult): string[] {
  return [...ids(result)].sort()
}

function withoutQueryPushdown(storage: ObjectStorage): ObjectStorage {
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "queryCapabilities") return () => ({ queryObjects: false })
      if (property === "queryObjects") return undefined

      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function expectPlanningIssue(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ObjectQueryPlanningError)
    if (error instanceof ObjectQueryPlanningError) {
      expect(error.issues.map((issue) => issue.code)).toContain(code)
    }
    return
  }

  throw new Error(`Expected ObjectQueryPlanningError with code '${code}'`)
}
