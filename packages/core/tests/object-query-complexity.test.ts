import { describe, expect, test } from "bun:test"
import type { ObjectQuery, ObjectQueryPredicate } from "../src/objects/query"
import {
  collectObjectQueryValidationIssues,
  normalizeObjectQuery,
  normalizeObjectQueryPredicate,
} from "../src/objects/query"

describe("object query structural bounds", () => {
  test("rejects cyclic queries and predicates before recursive normalization", () => {
    const query = { kind: "limit", limit: 1 } as ObjectQuery & { input?: ObjectQuery }
    query.input = query
    expect(() => normalizeObjectQuery(query)).toThrow("must not contain cycles")

    const predicate = { op: "not" } as ObjectQueryPredicate & { item?: ObjectQueryPredicate }
    predicate.item = predicate
    expect(() => normalizeObjectQueryPredicate(predicate)).toThrow("must not contain cycles")
  })

  test("bounds depth, total nodes, and cumulative raw array entries", () => {
    let deep: ObjectQuery = { kind: "start", objectTypeId: "Thing" }
    for (let index = 0; index < 33; index += 1) {
      deep = { kind: "limit", limit: 1, input: deep }
    }
    expect(() => normalizeObjectQuery(deep)).toThrow("maximum structural depth of 32")

    const tooManyNodes: ObjectQuery = {
      kind: "set",
      op: "union",
      inputs: Array.from({ length: 512 }, () => ({
        kind: "start" as const,
        objectTypeId: "Thing",
      })),
    }
    expect(() => normalizeObjectQuery(tooManyNodes)).toThrow("maximum of 512 structural nodes")

    const tooManyArrayEntries: ObjectQuery = {
      kind: "vector",
      input: { kind: "start", objectTypeId: "Thing" },
      propertyId: "embedding",
      vector: Array.from({ length: 4_097 }, () => 0),
      k: 1,
    }
    expect(() => normalizeObjectQuery(tooManyArrayEntries)).toThrow("maximum of 4096 array entries")

    const tooManyRefs: ObjectQuery = {
      kind: "refs",
      refs: Array.from({ length: 4_097 }, (_, index) => ({
        objectTypeId: "Thing",
        primaryId: `thing-${index}`,
      })),
    }
    expect(() => normalizeObjectQuery(tooManyRefs)).toThrow("maximum of 4096 array entries")

    const tooManyTextTypeEntries: ObjectQuery = {
      kind: "text",
      input: { kind: "start", objectTypeId: "Thing" },
      query: "needle",
      fieldsByObjectType: Object.fromEntries(
        Array.from({ length: 4_097 }, (_, index) => [`Thing${index}`, []])
      ),
    }
    expect(() => normalizeObjectQuery(tooManyTextTypeEntries)).toThrow(
      "maximum of 4096 array entries"
    )
  })

  test("accepts the exact node boundary and reports complexity through issue collection", () => {
    const atBoundary: ObjectQuery = {
      kind: "set",
      op: "union",
      inputs: Array.from({ length: 511 }, () => ({
        kind: "start" as const,
        objectTypeId: "Thing",
      })),
    }
    expect(normalizeObjectQuery(atBoundary).kind).toBe("set")

    const textTypesAtBoundary: ObjectQuery = {
      kind: "text",
      input: { kind: "start", objectTypeId: "Thing" },
      query: "needle",
      fieldsByObjectType: Object.fromEntries(
        Array.from({ length: 4_096 }, (_, index) => [`Thing${index}`, []])
      ),
    }
    expect(normalizeObjectQuery(textTypesAtBoundary).kind).toBe("text")

    const cyclic = { kind: "limit", limit: 1 } as ObjectQuery & { input?: ObjectQuery }
    cyclic.input = cyclic
    expect(
      collectObjectQueryValidationIssues(cyclic, {
        ontology: {} as never,
        normalize: false,
      })
    ).toMatchObject([{ code: "cyclic_query" }])
  })
})
