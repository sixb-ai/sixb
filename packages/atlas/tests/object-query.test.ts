import { describe, expect, test } from "bun:test"
import {
  getOperatorsForProperty,
  isFacetProperty,
  isFilterableProperty,
  isSortableProperty,
  type QueryProperty,
} from "../src/lib/objects/objectQuery"

function property(
  schema: unknown,
  capabilities: Partial<QueryProperty["capabilities"]>
): QueryProperty {
  return {
    id: "value",
    name: "Value",
    schema,
    capabilities: { operators: [], sortable: false, facet: false, text: false, ...capabilities },
  }
}

describe("Atlas object query properties", () => {
  test("offer the operators the server resolved, in display order", () => {
    const text = property("string", {
      operators: ["eq", "neq", "lt", "lte", "gt", "gte", "in", "contains", "exists"],
    })
    expect(getOperatorsForProperty(text)).toEqual([
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "exists",
      "missing",
    ])

    const flag = property("boolean", { operators: ["eq", "neq", "in", "exists"] })
    expect(getOperatorsForProperty(flag)).toEqual(["eq", "neq", "exists", "missing"])

    const tags = property({ type: "array", items: "string" }, { operators: ["contains"] })
    expect(getOperatorsForProperty(tags)).toEqual(["contains"])
  })

  test("resolve value-type properties from capabilities rather than the raw schema", () => {
    const reading = property(
      { type: "valueTypeRef", valueTypeId: "reading" },
      { operators: ["eq", "neq", "lt", "lte", "gt", "gte", "in", "exists"], sortable: true }
    )
    expect(getOperatorsForProperty(reading)).toEqual([
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "exists",
      "missing",
    ])
    expect(isSortableProperty(reading)).toBe(true)
  })

  test("limit primary ids without filter metadata to equality", () => {
    const id = { ...property("string", { operators: ["eq", "in"] }), primary: true }
    expect(getOperatorsForProperty(id)).toEqual(["eq"])
    expect(isFilterableProperty(id)).toBe(true)
  })

  test("hide properties the server reports no capability for", () => {
    const document = property("fileRef", {})
    expect(getOperatorsForProperty(document)).toEqual([])
    expect(isFilterableProperty(document)).toBe(false)
    expect(isSortableProperty(document)).toBe(false)
    expect(isFacetProperty(document)).toBe(false)
  })
})
