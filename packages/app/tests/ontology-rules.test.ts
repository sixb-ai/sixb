import { describe, expect, test } from "bun:test"
import { createSixbClient, listSyncRuns } from "@sixb/client"
import { unknownActiveStates } from "../src/pages/console/ontology/rules"
import { isUnrecorded } from "../src/pages/section-ui"

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

// This predicate is the only switch deciding which of three states the run and rule screens
// render — "not recorded", "empty", or "failed". A silent widening here would report a
// real outage as a configuration choice, so it is pinned rather than trusted.
describe("isUnrecorded", () => {
  test("recognizes only the 501 a run-history route returns without its storage role", async () => {
    for (const [status, unrecorded] of [
      [501, true],
      [400, false],
      [403, false],
      [404, false],
      [500, false],
      [502, false],
      [503, false],
    ] as const) {
      const client = createSixbClient({
        baseUrl: "http://localhost:3002",
        fetch: respondWith(
          jsonError(status, "[SixbServer] Sync run storage is not configured on this runtime.")
        ),
      })

      const { error } = await listSyncRuns({ client })
      expect(isUnrecorded(error)).toBe(unrecorded)
    }

    // A network failure never reaches a status at all.
    expect(isUnrecorded(new Error("fetch failed"))).toBe(false)
    expect(isUnrecorded(undefined)).toBe(false)
  })
})

// The rules screens derive a per-rule count from a list of states. An empty list is only
// a count of zero once the query answered, and three of the four ways it can be empty are
// not that — the badge used to read "None active" for all of them, in one case directly
// above a panel saying the state is not recorded.
describe("unknownActiveStates", () => {
  const answered = { isLoading: false, isError: false, error: undefined }

  test("lets a query that answered support a count", () => {
    expect(unknownActiveStates(answered)).toBeNull()
  })

  test("names each reason a count cannot be stated", () => {
    expect(unknownActiveStates({ ...answered, isLoading: true })).toEqual({ kind: "loading" })
    expect(unknownActiveStates({ ...answered, isError: true, error: new Error("boom") })).toEqual({
      kind: "error",
    })
  })

  test("reads a 501 as unrecorded rather than as the failure the query client sees", async () => {
    const client = createSixbClient({
      baseUrl: "http://localhost:3002",
      fetch: respondWith(
        jsonError(501, "[SixbServer] Rule state storage is not configured on this runtime.")
      ),
    })
    const { error } = await listSyncRuns({ client })

    // Ordering, not just recognition: react-query reports this as an error, so a plain
    // `isError` check first would have labelled a configuration choice a fault.
    expect(unknownActiveStates({ isLoading: false, isError: true, error })).toEqual({
      kind: "unrecorded",
    })
  })
})
