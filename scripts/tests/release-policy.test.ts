import { describe, expect, test } from "bun:test"
import { assertReleaseTagAllowed, isPreviewRelease } from "../release-policy"

describe("release policy", () => {
  test("classifies the 0.0.x line as preview releases", () => {
    expect(isPreviewRelease("0.0.1")).toBe(true)
    expect(isPreviewRelease("0.0.2-beta.1")).toBe(true)
    expect(isPreviewRelease("0.1.0")).toBe(false)
    expect(isPreviewRelease("1.0.0")).toBe(false)
  })

  test("publishes preview releases only to next", () => {
    expect(() => assertReleaseTagAllowed("0.0.1", "latest")).toThrow(/Use `--tag next`/)
    expect(() => assertReleaseTagAllowed("0.0.1", "beta")).toThrow(/Use `--tag next`/)
    expect(() => assertReleaseTagAllowed("0.0.1", "next")).not.toThrow()
    expect(() => assertReleaseTagAllowed("0.1.0", "latest")).not.toThrow()
  })
})
