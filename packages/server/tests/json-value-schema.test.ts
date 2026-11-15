import { expect, test } from "bun:test"
import type { z } from "zod"
import { JsonValueSchema } from "../src/schemas/common"

// Zod calls a lazy schema's getter at every value it checks. Built inside the getter, the union
// was built again at each node of every JSON value: a long thread's messages took seconds of CPU.
// Removal proof: build the union inside the getter again; the two reads are different schemas.
test("builds the JSON value union once, and still checks every nested value", () => {
  const lazy = JsonValueSchema as unknown as z.ZodLazy<z.ZodTypeAny>

  expect(lazy.schema).toBe(lazy.schema)
  expect(JsonValueSchema.parse({ a: [1, "b", null, { c: true }] })).toEqual({
    a: [1, "b", null, { c: true }],
  })
  expect(JsonValueSchema.safeParse({ a: [Number.POSITIVE_INFINITY] }).success).toBe(false)
  expect(JsonValueSchema.safeParse({ a: [undefined] }).success).toBe(false)
})
