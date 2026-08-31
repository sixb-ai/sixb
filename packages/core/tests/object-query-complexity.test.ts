import { describe, expect, test } from "bun:test"
import type { ObjectQuery, ObjectQueryPredicate } from "../src/objects/query"
import {
  collectObjectQueryValidationIssues,
  findObjectQueryStructureIssue,
  normalizeObjectQuery,
  normalizeObjectQueryPredicate,
  OBJECT_QUERY_STRUCTURE_LIMITS,
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
    for (let index = 0; index < OBJECT_QUERY_STRUCTURE_LIMITS.maxDepth + 1; index += 1) {
      deep = { kind: "limit", limit: 1, input: deep }
    }
    expect(() => normalizeObjectQuery(deep)).toThrow(
      `maximum structural depth of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxDepth}`
    )

    const tooManyNodes: ObjectQuery = {
      kind: "set",
      op: "union",
      inputs: Array.from({ length: OBJECT_QUERY_STRUCTURE_LIMITS.maxNodes }, () => ({
        kind: "start" as const,
        objectTypeId: "Thing",
      })),
    }
    expect(() => normalizeObjectQuery(tooManyNodes)).toThrow(
      `maximum of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxNodes} structural nodes`
    )

    const tooManyRefs: ObjectQuery = {
      kind: "refs",
      refs: Array.from(
        { length: OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries + 1 },
        (_, index) => ({ objectTypeId: "Thing", primaryId: `thing-${index}` })
      ),
    }
    expect(() => normalizeObjectQuery(tooManyRefs)).toThrow(
      `maximum of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries} array entries`
    )

    const tooManyTextTypeEntries: ObjectQuery = {
      kind: "text",
      input: { kind: "start", objectTypeId: "Thing" },
      query: "needle",
      fieldsByObjectType: Object.fromEntries(
        Array.from({ length: OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries + 1 }, (_, index) => [
          `Thing${index}`,
          [],
        ])
      ),
    }
    expect(() => normalizeObjectQuery(tooManyTextTypeEntries)).toThrow(
      `maximum of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries} array entries`
    )
  })

  test("bounds nested JSON predicate values without assigning them semantics", () => {
    let value: unknown = "leaf"
    for (let depth = 0; depth < OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueDepth + 2; depth += 1) {
      value = { child: value }
    }

    const issue = findObjectQueryStructureIssue({
      kind: "filter",
      input: { kind: "start", objectTypeId: "Thing" },
      predicate: { op: "eq", propertyId: "payload", value },
    })

    expect(issue).toMatchObject({ code: "query_json_value_depth_exceeded" })
  })

  test("stops before enqueueing an over-limit structural fan-out", () => {
    const inputs: unknown[] = []
    inputs.length = OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries + 1
    Object.defineProperty(inputs, OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries, {
      configurable: true,
      get(): never {
        throw new Error("The rejected fan-out must not be read.")
      },
    })

    expect(findObjectQueryStructureIssue({ kind: "set", op: "union", inputs })).toMatchObject({
      code: "query_array_entries_exceeded",
    })
  })

  test("bounds JSON array and object width before reading their children", () => {
    const arrayValue: unknown[] = []
    arrayValue.length = OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueEntries + 1
    Object.defineProperty(arrayValue, OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueEntries, {
      configurable: true,
      get(): never {
        throw new Error("The rejected JSON array must not be read.")
      },
    })

    const objectValue: Record<string, unknown> = {}
    Object.defineProperty(objectValue, "guard", {
      configurable: true,
      enumerable: true,
      get(): never {
        throw new Error("The rejected JSON object must not be read.")
      },
    })
    for (let index = 0; index < OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueEntries; index += 1) {
      objectValue[`field${index}`] = index
    }

    for (const value of [arrayValue, objectValue]) {
      expect(
        findObjectQueryStructureIssue({
          kind: "filter",
          input: { kind: "start", objectTypeId: "Thing" },
          predicate: { op: "eq", propertyId: "payload", value },
        })
      ).toMatchObject({ code: "query_json_value_entries_exceeded" })
    }
  })

  test("applies one cumulative JSON-entry budget across predicate values", () => {
    const first = Array.from(
      { length: OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueEntries - 1 },
      () => null
    )
    const second: unknown[] = [null, null]
    Object.defineProperty(second, 1, {
      configurable: true,
      get(): never {
        throw new Error("A container outside the remaining JSON budget must not be read.")
      },
    })

    expect(
      findObjectQueryStructureIssue({
        kind: "filter",
        input: { kind: "start", objectTypeId: "Thing" },
        predicate: { op: "in", propertyId: "payload", values: [first, second] },
      })
    ).toMatchObject({ code: "query_json_value_entries_exceeded" })
  })

  test("accepts exact boundaries and reports complexity through issue collection", () => {
    const atNodeBoundary: ObjectQuery = {
      kind: "set",
      op: "union",
      inputs: Array.from({ length: OBJECT_QUERY_STRUCTURE_LIMITS.maxNodes - 1 }, () => ({
        kind: "start" as const,
        objectTypeId: "Thing",
      })),
    }
    expect(normalizeObjectQuery(atNodeBoundary).kind).toBe("set")

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
