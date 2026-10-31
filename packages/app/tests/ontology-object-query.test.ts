import { describe, expect, test } from "bun:test"
import {
  getOperatorsForProperty,
  isFacetProperty,
  isFilterableProperty,
  isSortableProperty,
  type QueryProperty,
} from "../src/pages/console/ontology/lib/object-query"

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

describe("object query properties", () => {
  // The schema plays no part: a value type's operators come from its capabilities too.
  test.each([
    [
      "string",
      ["eq", "neq", "lt", "lte", "gt", "gte", "in", "contains", "exists"],
      ["eq", "neq", "lt", "lte", "gt", "gte", "contains", "exists", "missing"],
    ],
    ["boolean", ["eq", "neq", "in", "exists"], ["eq", "neq", "exists", "missing"]],
    [{ type: "array", items: "string" }, ["contains"], ["contains"]],
    [
      { type: "valueTypeRef", valueTypeId: "reading" },
      ["eq", "neq", "lt", "lte", "gt", "gte", "in", "exists"],
      ["eq", "neq", "lt", "lte", "gt", "gte", "exists", "missing"],
    ],
  ] as const)("of schema %o offer the resolved operators, in display order", (schema, operators, expected) => {
    expect(getOperatorsForProperty(property(schema, { operators: [...operators] }))).toEqual([
      ...expected,
    ])
  })

  test("filter, sort and facet as the server reports, and hide what it reports no capability for", () => {
    const reading = property(
      { type: "valueTypeRef", valueTypeId: "reading" },
      { operators: ["eq"], sortable: true, facet: true }
    )
    expect(isFilterableProperty(reading)).toBe(true)
    expect(isSortableProperty(reading)).toBe(true)
    expect(isFacetProperty(reading)).toBe(true)

    const document = property("fileRef", {})
    expect(getOperatorsForProperty(document)).toEqual([])
    expect(isFilterableProperty(document)).toBe(false)
    expect(isSortableProperty(document)).toBe(false)
    expect(isFacetProperty(document)).toBe(false)
  })
})
