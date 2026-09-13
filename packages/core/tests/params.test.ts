import { describe, expect, test } from "bun:test"
import { optional, param, type ValueType } from "../src"
import { param as actionParam } from "../src/actions"
import { coerceParamsToTyped, normalizeParams } from "../src/shared/params/validation"

const valueTypesById: ReadonlyMap<string, ValueType> = new Map()

describe("definition params", () => {
  test("treats prototype-like keys as data and never inherits missing params", () => {
    // Regression proof: restore property assignment in normalizeParams or inherited value reads.
    const config = { ["__proto__"]: param("string"), toString: optional(param("string")) }
    const input = JSON.parse('{"__proto__":"value"}')
    const normalized = normalizeParams(valueTypesById, config, input, {
      kind: "workspace",
      id: "test",
    })
    expect(Object.hasOwn(normalized, "__proto__")).toBe(true)
    expect(normalized.__proto__).toBe("value")
    expect(Object.hasOwn(normalized, "toString")).toBe(false)
    expect(Object.hasOwn(coerceParamsToTyped(config, normalized, valueTypesById), "toString")).toBe(
      false
    )
    expect(() =>
      normalizeParams(
        valueTypesById,
        { toString: param("string") },
        {},
        { kind: "workspace", id: "test" }
      )
    ).toThrow("Missing required param 'toString'")
  })
  test("keeps the existing Action builder on the shared implementation", () => {
    expect(actionParam).toBe(param)
    expect(
      optional(
        param("double", {
          description: "Requested temperature",
          semanticType: "Temperature",
          nullable: true,
        })
      )
    ).toEqual({
      schema: "double",
      required: false,
      description: "Requested temperature",
      semanticType: "Temperature",
      nullable: true,
    })
  })

  test("normalizes durable JSON and rehydrates typed runtime values", () => {
    const config = {
      clientId: param("string"),
      requestedAt: param("timestamp"),
      note: optional(param("string", { nullable: true })),
    }
    const requestedAt = new Date("2026-08-26T12:30:00.000Z")

    const normalized = normalizeParams(
      valueTypesById,
      config,
      { clientId: "acme", requestedAt, note: null },
      { kind: "agent", id: "engineering" }
    )

    expect(normalized).toEqual({
      clientId: "acme",
      requestedAt: "2026-08-26T12:30:00.000Z",
      note: null,
    })
    expect(coerceParamsToTyped(config, normalized, valueTypesById)).toEqual({
      clientId: "acme",
      requestedAt,
      note: null,
    })
  })

  test("reports unknown, missing, and invalid null values against the owning definition", () => {
    const config = { clientId: param("string") }

    expect(() =>
      normalizeParams(
        valueTypesById,
        config,
        { clientId: "acme", extra: true },
        {
          kind: "agent",
          id: "engineering",
        }
      )
    ).toThrow("Unknown param 'extra' for agent 'engineering'")

    expect(() =>
      normalizeParams(valueTypesById, config, {}, { kind: "agent", id: "engineering" })
    ).toThrow("Missing required param 'clientId' for agent 'engineering'")

    expect(() =>
      normalizeParams(
        valueTypesById,
        config,
        { clientId: null },
        {
          kind: "agent",
          id: "engineering",
        }
      )
    ).toThrow("[Sixb] Agent param engineering.clientId cannot be null")
  })
})
