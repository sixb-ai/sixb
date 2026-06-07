import { expect, test } from "bun:test"
import type { ObjectQuery } from "@sixb/core"
import {
  compilePgObjectCountQuery,
  compilePgObjectFacetQuery,
} from "../src/pg-object-query-compiler"

const sitePointQuery: ObjectQuery = {
  kind: "filter",
  predicate: { op: "eq", propertyId: "siteId", value: "site-1" },
  input: { kind: "start", objectTypeId: "BacnetPoint" },
}

test("count aggregate SQL omits inherited row ordering", () => {
  const compiled = compilePgObjectCountQuery("project-a", sitePointQuery)

  expect(compiled.sql).toContain("COUNT(*)::bigint AS count")
  expect(compiled.sql).not.toContain("ORDER BY")
  expect(compiled.sql).not.toContain("_cursor_properties")
  expect(compiled.sql).toContain("properties ->>")
  expect(compiled.args).toEqual(["project-a", "BacnetPoint", "siteId", "siteId", "site-1"])
})

test("count aggregate SQL supports scoped text defaults", () => {
  const compiled = compilePgObjectCountQuery("project-a", {
    kind: "text",
    query: "alpha collaboration",
    fieldsByObjectType: {
      Room: ["name", "description"],
    },
    input: { kind: "start", objectTypeId: "Room" },
  })

  expect(compiled.sql).toContain("COUNT(*)::bigint AS count")
  expect(compiled.sql).toContain("object_type_id = $3")
  expect(compiled.sql).toContain("position($4::text in lower(coalesce")
  expect(compiled.sql).not.toContain("ORDER BY")
  expect(compiled.args).toEqual([
    "project-a",
    "Room",
    "Room",
    "alpha",
    "name",
    "alpha",
    "description",
    "collaboration",
    "name",
    "collaboration",
    "description",
  ])
})

test("facet aggregate SQL projects scalar values without sorting object rows", () => {
  const compiled = compilePgObjectFacetQuery("project-a", sitePointQuery, "objectType", 100)

  expect(compiled.sql).toContain("input.properties ->>")
  expect(compiled.sql).toContain("GROUP BY facet.value_type, facet.value_text")
  expect(compiled.sql).toContain("ORDER BY count DESC, facet.value_text ASC")
  expect(compiled.sql).not.toContain("SELECT *")
  expect(compiled.sql).not.toContain("ORDER BY input.project_id")
  expect(compiled.sql).not.toContain("_cursor_properties")
  expect(compiled.args).toEqual([
    "objectType",
    "objectType",
    "project-a",
    "BacnetPoint",
    "siteId",
    "siteId",
    "site-1",
    "objectType",
    100,
  ])
})
