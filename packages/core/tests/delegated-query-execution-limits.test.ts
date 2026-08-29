import { describe, expect, test } from "bun:test"
import type { ObjectQuery } from "../src/objects/query"
import { executeObjectQuery } from "../src/objects/query"
import { defineObjectType, link, OntologyRegistry, prop } from "../src/ontology"
import type { ObjectReadStorage, ObjectRow, QueryObjectsResult } from "../src/storage"

const Thing = defineObjectType({
  id: "Thing",
  name: "Thing",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link.self("children", { cardinality: "many" })],
})
const ontology = new OntologyRegistry({ sources: [Thing] })
const projectId = "delegated-query-limits"

describe("delegated query execution limits", () => {
  test("requires an explicit limit for many expansions before storage", async () => {
    const observed = fakeReader(queryResult(1))
    await expect(
      run(expandQuery(1), observed.reader, { maxMaterializedObjects: 10 })
    ).rejects.toMatchObject({
      name: "ObjectQueryValidationError",
      issues: [{ code: "delegated_expand_limit_required" }],
    })
    expect(observed.calls()).toBe(0)
  })

  test("rejects a conservative over-budget plan and accepts its exact boundary", async () => {
    const rejected = fakeReader(queryResult(1))
    await expect(
      run(expandQuery(2, 1), rejected.reader, { maxMaterializedObjects: 3 })
    ).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "materializedObjects",
      limit: 3,
    })
    expect(rejected.calls()).toBe(0)

    const accepted = fakeReader(queryResult(2))
    const result = await run(expandQuery(1, 2), accepted.reader, {
      maxMaterializedObjects: 3,
    })
    expect(result.objects).toHaveLength(1)
    expect(accepted.calls()).toBe(1)
  })

  test("checks the actual provider result and releases no over-budget value", async () => {
    const observed = fakeReader(queryResult(3))
    await expect(
      run(expandQuery(1, 2), observed.reader, { maxMaterializedObjects: 3 })
    ).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "materializedObjects",
      limit: 3,
    })
    expect(observed.calls()).toBe(1)
  })

  test("rejects expansions nested in set inputs instead of silently discarding them", async () => {
    const observed = fakeReader(queryResult(1))
    await expect(
      run(
        {
          kind: "set",
          op: "union",
          inputs: [expandQuery(1), { kind: "start", objectTypeId: Thing.id }],
        },
        observed.reader,
        { maxMaterializedObjects: 10 }
      )
    ).rejects.toMatchObject({
      name: "ObjectQueryValidationError",
      issues: [{ code: "expand_inside_set" }],
    })
    expect(observed.calls()).toBe(0)
  })

  test("rejects unbounded roots and invalid fanout options before storage", async () => {
    const roots = fakeReader(queryResult(1))
    await expect(
      run({ kind: "start", objectTypeId: Thing.id }, roots.reader, {
        maxMaterializedObjects: 3,
      })
    ).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "materializedObjects",
      limit: 3,
    })
    expect(roots.calls()).toBe(0)

    for (const maxExpansionFanout of [-1, Number.NaN]) {
      const invalid = fakeReader(queryResult(1))
      await expect(
        run(expandQuery(1, 1), invalid.reader, {
          maxMaterializedObjects: 10,
          maxExpansionFanout,
        })
      ).rejects.toThrow("maxExpansionFanout must be a non-negative safe integer")
      expect(invalid.calls()).toBe(0)
    }
  })
})

function expandQuery(rootLimit: number, expansionLimit?: number): ObjectQuery {
  return {
    kind: "expand",
    input: {
      kind: "limit",
      limit: rootLimit,
      input: { kind: "start", objectTypeId: Thing.id },
    },
    expansions: [
      {
        linkId: "children",
        direction: "outgoing",
        ...(expansionLimit === undefined ? {} : { limit: expansionLimit }),
      },
    ],
  }
}

async function run(
  query: ObjectQuery,
  storage: ObjectReadStorage,
  input: { readonly maxMaterializedObjects: number; readonly maxExpansionFanout?: number }
) {
  return executeObjectQuery(
    { projectId, query },
    {
      ontology,
      storage,
      executionLimits: {
        maxTraversalFacts: 10,
        maxVisibleJsonBytes: 1_000_000,
        maxMaterializedObjects: input.maxMaterializedObjects,
      },
      maxExpansionFanout: input.maxExpansionFanout,
    }
  )
}

function fakeReader(result: QueryObjectsResult): {
  readonly reader: ObjectReadStorage
  readonly calls: () => number
} {
  let queryCalls = 0
  const reader: ObjectReadStorage = {
    queryCapabilities: () => ({
      queryObjects: true,
      nodes: { start: true, limit: true, expand: true },
    }),
    queryObjects: async () => {
      queryCalls += 1
      return structuredClone(result)
    },
    getByPrimaryId: async () => null,
    selectsObjectProperties: async (input) => input.items.map(() => false),
    listLinks: async () => [],
    getByPrimaryIdMany: async (input) => input.items.map(() => null),
    listLinksMany: async (input) => input.items.map(() => []),
    list: async () => ({ objects: [], hasMore: false, total: 0 }),
  }
  return { reader, calls: () => queryCalls }
}

function queryResult(childCount: number): QueryObjectsResult {
  const root = row("root")
  root.links = {
    children: Array.from({ length: childCount }, (_, index) => row(`child-${index}`)),
  }
  return { objects: [root], hasMore: false, total: 1 }
}

function row(primaryId: string): ObjectRow {
  const at = new Date("2026-01-01T00:00:00.000Z")
  return {
    projectId,
    objectTypeId: Thing.id,
    primaryId,
    properties: { id: primaryId },
    createdAt: at,
    updatedAt: at,
    version: 1,
    lastCommitId: `commit-${primaryId}`,
  }
}
