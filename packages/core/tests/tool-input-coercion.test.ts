import { describe, expect, test } from "bun:test"
import { coerceToolInput } from "../src/agents/tool-input-coercion"
import type { JsonObject } from "../src/json"

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    offset: { type: "integer" },
    ratio: { type: "number" },
    all: { type: "boolean" },
    files: { type: "array", items: { type: "string" } },
    note: { type: ["string", "null"] },
    kind: { enum: ["sheet", "page"] },
    meta: {
      type: "object",
      properties: { tag: { type: "string" }, depth: { type: "integer" } },
      required: ["tag"],
      additionalProperties: false,
    },
  },
  required: ["path"],
  additionalProperties: false,
} satisfies JsonObject

describe("coerceToolInput", () => {
  test("leaves out a null the schema does not allow for an optional property", () => {
    expect(coerceToolInput(schema, { path: "a.ts", offset: null, kind: null, all: null })).toEqual({
      path: "a.ts",
    })
  })

  test("keeps a null the schema allows, or one a required property got, for parseInput to judge", () => {
    expect(coerceToolInput(schema, { path: null, note: null })).toEqual({ path: null, note: null })
    expect(coerceToolInput(schema, { path: "a", meta: { tag: null, depth: null } })).toEqual({
      path: "a",
      meta: { tag: null },
    })
  })

  test("reads numbers and booleans sent as strings", () => {
    expect(
      coerceToolInput(schema, { path: "a", offset: " 42 ", ratio: "0.5", all: "true" })
    ).toEqual({ path: "a", offset: 42, ratio: 0.5, all: true })
  })

  test("leaves strings that are not one exact reading", () => {
    const input = { path: "a", offset: "4.2", ratio: "half", all: "yes" }
    expect(coerceToolInput(schema, input)).toEqual(input)
  })

  test("wraps one value sent for an array", () => {
    expect(coerceToolInput(schema, { path: "a", files: "b.ts" })).toEqual({
      path: "a",
      files: ["b.ts"],
    })
  })

  test("keeps properties the schema does not name, and values that already fit", () => {
    const input = { path: "a", offset: 3, files: ["b"], extra: null }
    expect(coerceToolInput(schema, input)).toEqual(input)
  })

  test("never changes the input it was given", () => {
    const input = { path: "a", offset: null }
    coerceToolInput(schema, input)
    expect(input).toEqual({ path: "a", offset: null })
  })

  test("leaves a value that is not an object to parseInput", () => {
    expect(coerceToolInput(schema, "a.ts")).toBe("a.ts")
    expect(coerceToolInput(schema, null)).toBeNull()
  })
})
