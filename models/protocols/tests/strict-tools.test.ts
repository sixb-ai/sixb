import { describe, expect, test } from "bun:test"
import type { JsonObject } from "@sixb/core/models"
import {
  isStrictToolLimitError,
  messagesStrictTools,
  requiredNullableSchema,
  StrictToolRefusals,
  strictToolsKey,
} from "../src/strict-tools"

const closed = (properties: JsonObject, required: string[]): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

describe("requiredNullableSchema", () => {
  test("requires every property, and makes the optional ones nullable", () => {
    const schema = closed(
      {
        path: { type: "string", description: "Where." },
        offset: { type: "integer", minimum: 1 },
        kind: { enum: ["sheet", "page"] },
        note: { type: ["string", "null"] },
        meta: closed({ tag: { type: "string" }, depth: { type: "integer" } }, ["tag"]),
        files: { type: "array", items: closed({ name: { type: "string" } }, []) },
      },
      ["path"]
    )

    expect(requiredNullableSchema(schema)).toEqual(
      closed(
        {
          path: { type: "string", description: "Where." },
          offset: { type: ["integer", "null"], minimum: 1 },
          kind: { anyOf: [{ enum: ["sheet", "page"] }, { type: "null" }] },
          note: { type: ["string", "null"] },
          meta: {
            type: ["object", "null"],
            properties: { tag: { type: "string" }, depth: { type: ["integer", "null"] } },
            required: ["tag", "depth"],
            additionalProperties: false,
          },
          files: {
            type: ["array", "null"],
            items: closed({ name: { type: ["string", "null"] } }, ["name"]),
          },
        },
        ["path", "offset", "kind", "note", "meta", "files"]
      )
    )
    // The tool's own schema is untouched.
    expect(schema.required).toEqual(["path"])
  })
})

describe("messagesStrictTools", () => {
  const one = closed({ q: { type: "string" } }, ["q"])

  test("chooses, in order, the tools that asked and fit what is left", () => {
    const optional = (count: number) =>
      closed(Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, {}])), [])
    const unions = (count: number) =>
      closed(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`p${index}`, { type: ["string", "null"] }])
        ),
        Array.from({ length: count }, (_, index) => `p${index}`)
      )

    expect(
      messagesStrictTools([
        { schema: one },
        { strict: true, schema: undefined },
        { strict: true, schema: optional(20) },
        { strict: true, schema: optional(5) },
        { strict: true, schema: optional(4) },
        { strict: true, schema: unions(16) },
        { strict: true, schema: unions(1) },
      ])
    ).toEqual([false, false, true, false, true, true, false])
  })

  test("stops at 20 strict tools, and counts the output schema first", () => {
    const tools = Array.from({ length: 21 }, () => ({ strict: true, schema: one }))
    expect(messagesStrictTools(tools).filter(Boolean)).toHaveLength(20)

    const output = closed(
      Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`p${index}`, {}])),
      []
    )
    const optional = closed({ maybe: { type: "string" } }, [])
    expect(messagesStrictTools([{ strict: true, schema: optional }], output)).toEqual([false])
  })
})

test("isStrictToolLimitError knows Anthropic's refusals of strict tools, and only those", () => {
  // As Anthropic sent them, November 2026; the grammar one is the documented wording.
  for (const message of [
    "Too many strict tools (21). The maximum number of strict tools supported is 20. Try reducing the number of tools marked as strict.",
    "Schemas contains too many optional parameters (25), which would make grammar compilation inefficient. Reduce the number of optional parameters in your tool schemas (limit: 24).",
    "Schemas contains too many parameters with union types (17 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions).",
    "Schema is too complex for compilation.",
    "The compiled grammar is too large, which would cause performance issues.",
  ]) {
    expect(isStrictToolLimitError({ status: 400, message })).toBe(true)
  }
  expect(isStrictToolLimitError({ status: 400, message: "prompt is too long" })).toBe(false)
  expect(
    isStrictToolLimitError({ status: 500, message: "The compiled grammar is too large" })
  ).toBe(false)
})

test("StrictToolRefusals keeps the newest sets, by their definitions", () => {
  const refusals = new StrictToolRefusals(2)
  const keys = ["a", "b", "c"].map((name) => strictToolsKey([{ name }]))
  expect(new Set(keys).size).toBe(3)
  for (const key of keys) refusals.add(key)
  expect(keys.map((key) => refusals.has(key))).toEqual([false, true, true])
  expect(strictToolsKey([{ name: "a" }])).toBe(keys[0] as string)
})
