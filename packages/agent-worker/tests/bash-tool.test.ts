import { describe, expect, test } from "bun:test"
import { compressStdout } from "../src/bash-tool"

const CAP = 200

describe("compressStdout", () => {
  test("leaves output under the cap untouched", () => {
    const text = `[{"id":"Customer"}]`
    expect(compressStdout(text, CAP)).toEqual({ text, truncated: false })
  })

  test("compacts pretty-printed JSON that fits once whitespace is dropped", () => {
    const value = Array.from({ length: 6 }, (_, index) => ({
      id: `type-${index}`,
      name: `Type ${index}`,
    }))
    const pretty = JSON.stringify(value, null, 2)
    const cap = 250
    // The pretty form overflows the cap purely on whitespace; the compact form fits.
    expect(pretty.length).toBeGreaterThan(cap)
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(cap)

    const result = compressStdout(pretty, cap)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(JSON.stringify(value))
    // Round-trips to the same data — nothing was dropped.
    expect(JSON.parse(result.text)).toEqual(value)
  })

  test("keeps a valid whole-element array prefix when compaction is not enough", () => {
    const value = Array.from({ length: 200 }, (_, index) => ({
      id: `type-${index}`,
      name: `Type ${index}`,
    }))
    const result = compressStdout(JSON.stringify(value), CAP)

    expect(result.truncated).toBe(true)
    const parsed = JSON.parse(result.text) // must still be valid JSON
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed.length).toBeLessThan(value.length)
    expect(result.text.length).toBeLessThanOrEqual(CAP)
    // The kept elements are the untouched leading originals.
    expect(parsed[0]).toEqual(value[0])
  })

  test("middle-truncates a single oversized object, preserving head and tail", () => {
    const value = { id: "Customer", blob: "x".repeat(500), tail: "END" }
    const result = compressStdout(JSON.stringify(value), CAP)

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(CAP)
    expect(result.text.startsWith(`{"id":"Customer"`)).toBe(true)
    expect(result.text.endsWith(`"tail":"END"}`)).toBe(true)
    expect(result.text).toContain("truncated to")
  })

  test("middle-truncates non-JSON output, keeping head and tail", () => {
    const text = `START ${"a".repeat(500)} FINISH`
    const result = compressStdout(text, CAP)

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(CAP)
    expect(result.text.startsWith("START ")).toBe(true)
    expect(result.text.endsWith(" FINISH")).toBe(true)
  })
})
