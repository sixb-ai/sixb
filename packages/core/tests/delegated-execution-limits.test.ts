import { describe, expect, test } from "bun:test"
import { assertVisibleJsonWithinLimit } from "../src/storage/objects/execution-limits"

describe("delegated execution limits", () => {
  test("counts the exact JSON UTF-8 representation at the byte boundary", () => {
    const value = {
      ascii: "plain",
      unicode: "é😀",
      escaped: 'quote:" slash:\\ newline:\n',
      array: [undefined, Number.NaN, null],
      omitted: undefined,
      at: new Date("2026-01-01T00:00:00.000Z"),
    }
    const encoded = JSON.stringify(value)
    const exactBytes = new TextEncoder().encode(encoded).byteLength

    expect(() =>
      assertVisibleJsonWithinLimit(value, { maxVisibleJsonBytes: exactBytes })
    ).not.toThrow()
    expect(() =>
      assertVisibleJsonWithinLimit(value, { maxVisibleJsonBytes: exactBytes - 1 })
    ).toThrow(expect.objectContaining({ metric: "visibleJsonBytes", limit: exactBytes - 1 }))
  })

  test("stops oversized, deeply nested, and cyclic values with the stable limit error", () => {
    expect(() =>
      assertVisibleJsonWithinLimit("x".repeat(10_000), { maxVisibleJsonBytes: 128 })
    ).toThrow(expect.objectContaining({ metric: "visibleJsonBytes", limit: 128 }))

    let deep: unknown = "leaf"
    for (let index = 0; index < 70; index += 1) deep = { nested: deep }
    expect(() => assertVisibleJsonWithinLimit(deep, { maxVisibleJsonBytes: 1_000_000 })).toThrow(
      expect.objectContaining({ metric: "visibleJsonBytes", limit: 1_000_000 })
    )

    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => assertVisibleJsonWithinLimit(cyclic, { maxVisibleJsonBytes: 1_000_000 })).toThrow(
      expect.objectContaining({ metric: "visibleJsonBytes", limit: 1_000_000 })
    )
  })
})
