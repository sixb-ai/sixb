import { describe, expect, test } from "bun:test"
import { createSixbClient, listSyncRuns } from "@sixb/client"
import { isUnconfiguredStorageError } from "../src/components/UnrecordedHistoryState"

function respondWith(response: () => Response) {
  return Object.assign(async () => response(), { preconnect: fetch.preconnect }) as typeof fetch
}

function jsonError(status: number, message: string) {
  return () =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
}

// This predicate is the only switch deciding which of three states six Atlas screens
// render — "not recorded", "empty", or "failed". A silent widening here would report a
// real outage as a configuration choice, so it is pinned rather than trusted.
describe("isUnconfiguredStorageError", () => {
  test("recognizes the 501 a run-history route returns without its storage role", async () => {
    const client = createSixbClient({
      baseUrl: "http://localhost:3002",
      fetch: respondWith(
        jsonError(501, "[SixbServer] Sync run storage is not configured on this runtime.")
      ),
    })

    const { error } = await listSyncRuns({ client })
    expect(isUnconfiguredStorageError(error)).toBe(true)
  })

  test("does not claim any other failure", async () => {
    for (const status of [400, 403, 404, 500, 502, 503]) {
      const client = createSixbClient({
        baseUrl: "http://localhost:3002",
        fetch: respondWith(jsonError(status, "Boom")),
      })

      const { error } = await listSyncRuns({ client })
      expect(isUnconfiguredStorageError(error)).toBe(false)
    }

    // A network failure never reaches a status at all.
    expect(isUnconfiguredStorageError(new Error("fetch failed"))).toBe(false)
    expect(isUnconfiguredStorageError(undefined)).toBe(false)
  })
})
