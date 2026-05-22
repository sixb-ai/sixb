import { describe, expect, test } from "bun:test"
import { defineFunction, defineObjectType, FunctionValidationError, Pario, prop } from "../src"
import { createCronMatcher } from "../src/schedules"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
    prop("currentTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
  ],
})

describe("function runtime", () => {
  test("matches cron expressions with step fields", () => {
    const matcher = createCronMatcher("*/5 * * * *")

    expect(matcher(new Date("2026-01-01T10:00:00.000Z"))).toBe(true)
    expect(matcher(new Date("2026-01-01T10:04:00.000Z"))).toBe(false)
    expect(matcher(new Date("2026-01-01T10:05:00.000Z"))).toBe(true)
  })

  test("rejects duplicate function ids", async () => {
    const fn1 = defineFunction("duplicate-id")
      .cron("* * * * *")
      .run(async () => {})

    const fn2 = defineFunction("duplicate-id")
      .cron("*/5 * * * *")
      .run(async () => {})

    const pario = new Pario({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      functions: [fn1, fn2],
    })

    await expect(pario.startFunctions()).rejects.toBeInstanceOf(FunctionValidationError)
    await expect(pario.startFunctions()).rejects.toThrow("Duplicate function id 'duplicate-id'")
  })

  test("validates empty function id", () => {
    expect(() => defineFunction("")).toThrow(FunctionValidationError)
    expect(() => defineFunction("")).toThrow("Function id must not be empty")
  })

  test("validates empty cron expression", () => {
    expect(() => defineFunction("test").cron("")).toThrow(FunctionValidationError)
    expect(() => defineFunction("test").cron("")).toThrow(
      "Function cron expression must not be empty"
    )
  })
})
