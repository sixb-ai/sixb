import { describe, expect, test } from "bun:test"
import {
  compareDecimalValues,
  decimal,
  defineObjectType,
  isDecimalString,
  isDecimalValue,
  link,
  normalizeDecimalValue,
  OntologyRegistry,
  OntologyValidationError,
  prop,
} from "../src"
import {
  validateLinkAuthorityProperties,
  validateObjectAuthorityProperties,
  validateTelemetryPoint,
} from "../src/materializer/effective/validate"
import { normalizeSchemaValue, validateSchemaValue } from "../src/ontology/validation"

const valueTypes = new Map()

describe("exact decimal values", () => {
  test("normalizes to a stable JSON-safe representation", () => {
    expect(String(decimal("+000123.45000"))).toBe("123.45")
    expect(String(decimal("-000.000"))).toBe("0")
    expect(String(decimal(9_007_199_254_740_993n))).toBe("9007199254740993")
    expect(() => normalizeDecimalValue(".5")).toThrow(TypeError)
  })

  test("rejects exponent notation and non-finite values", () => {
    for (const value of ["1e3", "NaN", "Infinity", "1.", ".1", ""]) {
      expect(() => decimal(value)).toThrow(TypeError)
      expect(isDecimalString(value)).toBe(false)
    }
  })

  test("rejects values outside the cross-provider exact precision", () => {
    const excessiveFraction = `0.${"1".repeat(16_384)}`
    expect(() => decimal(excessiveFraction)).toThrow("exceeds the supported precision")
    expect(isDecimalString(excessiveFraction)).toBe(false)
  })

  test("distinguishes valid input strings from canonical values", () => {
    expect(isDecimalString("+001.2300")).toBe(true)
    expect(isDecimalValue("+001.2300")).toBe(false)
    expect(isDecimalValue("1.23")).toBe(true)
  })

  test("compares values exactly beyond JavaScript number precision", () => {
    expect(compareDecimalValues("9007199254740992", "9007199254740993")).toBeLessThan(0)
    expect(compareDecimalValues("0.00000000000000000002", "0.0000000000000000001")).toBeLessThan(0)
    expect(compareDecimalValues("-100000000000000000000", "-99999999999999999999")).toBeLessThan(0)
    expect(compareDecimalValues("001.2300", "+1.23")).toBe(0)
  })

  test("validates decimal strings and canonicalizes them at storage boundaries", () => {
    expect(() => validateSchemaValue("decimal", "001.2300", "amount", valueTypes)).not.toThrow()
    expect(normalizeSchemaValue("decimal", "001.2300", "amount", valueTypes)).toBe("1.23")

    for (const value of [1.23, "1e3", Number.NaN]) {
      expect(() => validateSchemaValue("decimal", value, "amount", valueTypes)).toThrow(
        OntologyValidationError
      )
    }
  })

  test("canonicalizes decimal values at materializer authority boundaries", () => {
    const Account = defineObjectType({
      id: "Account",
      name: "Account",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("balance", "decimal"),
        prop("reading", "decimal", { mode: "telemetry" }),
      ],
      links: [
        link.ref("transfers", "Account", {
          properties: [prop("amount", "decimal")],
        }),
      ],
    })
    const ontology = new OntologyRegistry({ sources: [Account] })
    const accountRef = { objectTypeId: "Account", primaryId: "account-1" }

    expect(
      validateObjectAuthorityProperties(ontology, accountRef, { balance: "+001.2300" })
    ).toEqual({ balance: "1.23" })
    expect(
      validateLinkAuthorityProperties(
        ontology,
        {
          source: accountRef,
          linkId: "transfers",
          target: { objectTypeId: "Account", primaryId: "account-2" },
        },
        { amount: "002.500" }
      )
    ).toEqual({ amount: "2.5" })
    expect(
      validateTelemetryPoint(ontology, {
        series: { object: accountRef, propertyId: "reading" },
        value: "0003.1400",
        at: "2026-01-01T00:00:00.000Z",
      }).value
    ).toBe("3.14")
  })
})
