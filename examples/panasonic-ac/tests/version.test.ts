import { describe, expect, test } from "bun:test"
import { resolvePanasonicAppVersion } from "../lib/panasonic/version"

describe("resolvePanasonicAppVersion", () => {
  test("prefers an explicit override without contacting the App Store", async () => {
    let fetched = false

    const version = await resolvePanasonicAppVersion({
      override: "4.3.1",
      fetch: (() => {
        fetched = true
        throw new Error("unexpected fetch")
      }) as typeof fetch,
    })

    expect(version).toBe("4.3.1")
    expect(fetched).toBe(false)
  })

  test("uses the version published by the App Store", async () => {
    const version = await resolvePanasonicAppVersion({
      fetch: (() =>
        Promise.resolve(
          Response.json({ resultCount: 1, results: [{ version: "4.3.0" }] })
        )) as typeof fetch,
    })

    expect(version).toBe("4.3.0")
  })

  test("falls back when the lookup is unavailable or malformed", async () => {
    const unavailable = await resolvePanasonicAppVersion({
      fetch: (() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch,
    })
    const malformed = await resolvePanasonicAppVersion({
      fetch: (() =>
        Promise.resolve(Response.json({ results: [{ version: "latest" }] }))) as typeof fetch,
    })

    expect(unavailable).toBe("4.3.0")
    expect(malformed).toBe("4.3.0")
  })

  test("rejects an invalid explicit override", async () => {
    expect(resolvePanasonicAppVersion({ override: "latest" })).rejects.toThrow(
      "PANASONIC_APP_VERSION must use the x.y.z format"
    )
  })
})
