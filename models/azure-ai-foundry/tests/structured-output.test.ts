import { expect, test } from "bun:test"
import type { JsonObject } from "@sixb/core/models"
import { foundryOutputSchema } from "../src/structured-output"

function closed(properties: JsonObject): JsonObject {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}

// Regression proof: raise the 100-property bound in structured-output.ts to 101; this test fails.
test("enforces Azure's property and nesting limits including referenced schemas", () => {
  const properties = Object.fromEntries(
    Array.from({ length: 100 }, (_, n) => [`field${n}`, { type: "string" }])
  )
  expect(foundryOutputSchema(closed(properties))).toBeDefined()
  expect(foundryOutputSchema(closed({ ...properties, extra: { type: "string" } }))).toBeUndefined()
  const child = closed({ value: { type: "string" } })
  expect(
    foundryOutputSchema(
      closed(Object.fromEntries(Array.from({ length: 60 }, (_, n) => [`field${n}`, child])))
    )
  ).toBeUndefined()
  let schema = closed({ value: { type: "string" } })
  for (let level = 1; level < 5; level++) schema = closed({ child: schema })
  expect(foundryOutputSchema(schema)).toBeDefined()
  expect(foundryOutputSchema(closed({ child: schema }))).toBeUndefined()
  expect(
    foundryOutputSchema({ ...closed({ child: { $ref: "#/$defs/deep" } }), $defs: { deep: schema } })
  ).toBeUndefined()
})

test("preserves nullable unions and valid local recursion without accepting unsupported keywords", () => {
  const schema = {
    ...closed({
      value: { type: ["string", "null"] },
      children: { type: "array", items: { $ref: "#" } },
    }),
  }
  expect(foundryOutputSchema(schema)).toBe(schema)
  expect(foundryOutputSchema(closed({ value: { type: ["string", "number"] } }))).toBeUndefined()
  const ref = {
    ...closed({ child: { $ref: "#/$defs/child" } }),
    $defs: { child: closed({ value: { type: "string" } }) },
  }
  expect(foundryOutputSchema(ref)).toBe(ref)
  for (const keyword of [
    "minLength",
    "pattern",
    "format",
    "minimum",
    "maxItems",
    "oneOf",
    "allOf",
  ]) {
    expect(foundryOutputSchema(closed({ value: { type: "string", [keyword]: 1 } }))).toBeUndefined()
  }
  expect(foundryOutputSchema(closed({ missing: { $ref: "#/missing" } }))).toBeUndefined()
  expect(
    foundryOutputSchema({
      ...closed({ child: { $ref: "#/$defs/loop" } }),
      $defs: { loop: { $ref: "#/$defs/loop" } },
    })
  ).toBeUndefined()
  expect(foundryOutputSchema({ ...closed({}), anyOf: [closed({})] })).toBeUndefined()
})
