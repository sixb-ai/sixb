import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import type { ObjectQuery } from "@sixb/core"
import { QueryClient, type QueryKey, QueryObserver } from "@tanstack/react-query"
import { createClient, createConfig } from "../src/generated/client"
import {
  listenToObjectQueryChanges,
  noteEventStreamConnected,
  noteObjectTypesChanged,
} from "../src/object-query-live-updates"
import { objectQueryReadsAny, rememberObjectQueryReads } from "../src/object-query-reads"
import { createHttpQueryExecutor } from "../src/query"

const query = (objectTypeId: string): ObjectQuery => ({ kind: "start", objectTypeId })
const key = (objectTypeId: string): QueryKey => [
  "sixb",
  "objects",
  "query",
  query(objectTypeId),
  null,
]

function clientWith(...objectTypeIds: string[]): QueryClient {
  const client = new QueryClient()
  for (const objectTypeId of objectTypeIds) client.setQueryData(key(objectTypeId), { objects: [] })
  listenToObjectQueryChanges(client)
  return client
}

const invalidated = (client: QueryClient, objectTypeId: string) =>
  client.getQueryState(key(objectTypeId))?.isInvalidated

describe("object query live updates", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test("refreshes only the queries that read a changed type", () => {
    const client = clientWith("Quote", "Timecard")
    rememberObjectQueryReads(undefined, query("Quote"), ["Quote", "Organization"])
    rememberObjectQueryReads(undefined, query("Timecard"), ["Timecard"])

    noteObjectTypesChanged(client, ["Organization"])
    jest.advanceTimersByTime(1_000)

    expect(invalidated(client, "Quote")).toBe(true)
    expect(invalidated(client, "Timecard")).toBe(false)
  })

  test("a query that has not answered yet counts as reading everything", () => {
    const client = clientWith("NotAnswered")

    noteObjectTypesChanged(client, ["Anything"])
    jest.advanceTimersByTime(1_000)

    expect(invalidated(client, "NotAnswered")).toBe(true)
  })

  test("changes in one window refresh once, with every type they named", () => {
    const client = clientWith("Quote", "Site")
    rememberObjectQueryReads(undefined, query("Quote"), ["Quote"])
    rememberObjectQueryReads(undefined, query("Site"), ["Site"])
    const invalidate = jest.spyOn(client, "invalidateQueries")

    noteObjectTypesChanged(client, ["Quote"])
    jest.advanceTimersByTime(500)
    noteObjectTypesChanged(client, ["Site"])
    jest.advanceTimersByTime(499)
    expect(invalidate).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)

    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidated(client, "Quote")).toBe(true)
    expect(invalidated(client, "Site")).toBe(true)
  })

  test("waits for a hidden page to show again", () => {
    const client = clientWith("Quote")
    rememberObjectQueryReads(undefined, query("Quote"), ["Quote"])
    const listeners: (() => void)[] = []
    const original = globalThis.document
    const fake = {
      visibilityState: "hidden",
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => {},
    }
    Object.defineProperty(globalThis, "document", { value: fake, configurable: true })
    try {
      noteObjectTypesChanged(client, ["Quote"])
      jest.advanceTimersByTime(1_000)
      expect(invalidated(client, "Quote")).toBe(false)

      fake.visibilityState = "visible"
      listeners[0]?.()
      expect(invalidated(client, "Quote")).toBe(true)
    } finally {
      Object.defineProperty(globalThis, "document", { value: original, configurable: true })
    }
  })

  // Removal proof: invalidate fetching queries like the others. invalidateQueries then cancels and
  // restarts this read on every window, so `reads` passes 1 before the first one finishes.
  test("a query already fetching finishes, then reads once more", async () => {
    const client = new QueryClient()
    listenToObjectQueryChanges(client)
    rememberObjectQueryReads(undefined, query("Slow"), ["Slow"])
    let reads = 0
    const finishes: (() => void)[] = []
    const observer = new QueryObserver(client, {
      queryKey: key("Slow"),
      queryFn: () =>
        new Promise((resolve) => {
          reads += 1
          finishes.push(() => resolve({ objects: [] }))
        }),
    })
    const stop = observer.subscribe(() => {})

    for (let window = 0; window < 3; window++) {
      noteObjectTypesChanged(client, ["Slow"])
      jest.advanceTimersByTime(1_000)
    }
    expect(reads).toBe(1)

    finishes[0]?.()
    await client.getQueryCache().find({ queryKey: key("Slow") })?.promise
    jest.advanceTimersByTime(1_000)
    expect(reads).toBe(2)

    stop()
  })

  // Removal proof: clear the pending changes without invalidating. The query below then looks
  // current on the next mount, though the event that changed it is gone.
  test("the last listener leaving marks pending changes stale without reading", () => {
    const client = new QueryClient()
    client.setQueryData(key("Quote"), { objects: [] })
    rememberObjectQueryReads(undefined, query("Quote"), ["Quote"])
    const stop = listenToObjectQueryChanges(client)
    const invalidate = jest.spyOn(client, "invalidateQueries")

    noteObjectTypesChanged(client, ["Quote"])
    stop()
    jest.advanceTimersByTime(1_000)

    expect(invalidated(client, "Quote")).toBe(true)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate.mock.calls[0]?.[0]?.refetchType).toBe("none")
  })

  test("a reconnect refreshes everything once the window closes, the first connection nothing", () => {
    const client = clientWith("Quote")
    rememberObjectQueryReads(undefined, query("Quote"), ["Quote"])

    let stream = noteEventStreamConnected(client, undefined, true)
    jest.advanceTimersByTime(1_000)
    expect(invalidated(client, "Quote")).toBe(false)

    stream = noteEventStreamConnected(client, stream, false)
    jest.advanceTimersByTime(1_000)
    expect(invalidated(client, "Quote")).toBe(false)

    noteEventStreamConnected(client, stream, true)
    expect(invalidated(client, "Quote")).toBe(false)
    jest.advanceTimersByTime(1_000)
    expect(invalidated(client, "Quote")).toBe(true)
  })

  // Removal proof: keep one connection history per cache. Another view mounting then starts
  // disconnected and connects, which reads as a reconnect and refreshes every query.
  test("another view mounting is not a reconnect", () => {
    const client = clientWith("Quote")
    rememberObjectQueryReads(undefined, query("Quote"), ["Quote"])

    noteEventStreamConnected(client, undefined, true)
    const another = noteEventStreamConnected(client, undefined, false)
    noteEventStreamConnected(client, another, true)
    jest.advanceTimersByTime(1_000)

    expect(invalidated(client, "Quote")).toBe(false)
  })

  test("a query the last listener left stale is read again by the next", async () => {
    const client = new QueryClient()
    const stop = listenToObjectQueryChanges(client)
    rememberObjectQueryReads(undefined, query("Left"), ["Left"])
    let reads = 0
    const observer = new QueryObserver(client, {
      queryKey: key("Left"),
      queryFn: async () => {
        reads += 1
        return { objects: [] }
      },
    })
    const stopObserving = observer.subscribe(() => {})
    await client.getQueryCache().find({ queryKey: key("Left") })?.promise
    expect(reads).toBe(1)

    noteObjectTypesChanged(client, ["Left"])
    stop()
    await Promise.resolve()
    expect(reads).toBe(1)

    listenToObjectQueryChanges(client)
    jest.advanceTimersByTime(1_000)
    expect(reads).toBe(2)

    stopObserving()
  })

  // Removal proof: re-read everything that was fetching. Each page loaded during a burst then reads
  // twice, though its first answer shows the change has nothing to do with it.
  test("a query loading when a change arrives skips the second read if it does not read that type", async () => {
    const client = new QueryClient()
    listenToObjectQueryChanges(client)
    let reads = 0
    const finishes: (() => void)[] = []
    const observer = new QueryObserver(client, {
      queryKey: key("Unrelated"),
      queryFn: () =>
        new Promise((resolve) => {
          reads += 1
          finishes.push(() => resolve({ objects: [] }))
        }),
    })
    const stopObserving = observer.subscribe(() => {})

    noteObjectTypesChanged(client, ["Email"])
    jest.advanceTimersByTime(1_000)

    rememberObjectQueryReads(undefined, query("Unrelated"), ["Unrelated"])
    finishes[0]?.()
    await client.getQueryCache().find({ queryKey: key("Unrelated") })?.promise
    jest.advanceTimersByTime(1_000)

    expect(reads).toBe(1)
    stopObserving()
  })

  test("nothing is noted while nobody listens", () => {
    const client = new QueryClient()
    client.setQueryData(key("Quote"), { objects: [] })

    noteObjectTypesChanged(client, ["Quote"])
    jest.advanceTimersByTime(1_000)

    expect(invalidated(client, "Quote")).toBe(false)
  })
})

describe("remembered reads", () => {
  // Removal proof: drop rememberObjectQueryReads from the executor's list. The answer below is then
  // never remembered, and this query refreshes on every change.
  test("an answer from the API is what gets remembered", async () => {
    const client = createClient(
      createConfig({
        baseUrl: "http://localhost",
        fetch: (async () =>
          Response.json({
            objects: [],
            hasMore: false,
            plan: {
              mode: "pushdown",
              providerIssues: [],
              fallbackIssues: [],
              issues: [],
              readObjectTypeIds: ["FromApi"],
            },
          })) as unknown as typeof fetch,
      })
    )
    const input: ObjectQuery = { kind: "start", objectTypeId: "FromApi" }

    await createHttpQueryExecutor(client).list({ kind: "page", pageSize: 10, input })

    expect(objectQueryReadsAny(client, input, new Set(["Other"]))).toBe(false)
    expect(objectQueryReadsAny(client, input, new Set(["FromApi"]))).toBe(true)
  })

  // Removal proof: remember every query under its own key. The page-wrapped query is then what is
  // stored, the cache's key finds nothing, and this query refreshes on every change.
  test("an infinite query is found by the query it pages through, on any page", () => {
    const input: ObjectQuery = { kind: "start", objectTypeId: "Paged" }
    rememberObjectQueryReads(undefined, { kind: "page", pageSize: 10, input }, ["Paged"])
    expect(objectQueryReadsAny(undefined, input, new Set(["Other"]))).toBe(false)

    rememberObjectQueryReads(undefined, { kind: "page", pageSize: 10, pageToken: "next", input }, [
      "Paged",
    ])
    expect(objectQueryReadsAny(undefined, input, new Set(["Other"]))).toBe(false)
    expect(objectQueryReadsAny(undefined, input, new Set(["Paged"]))).toBe(true)
  })

  test("a plain page query is found on any page", () => {
    const input: ObjectQuery = { kind: "start", objectTypeId: "PlainPage" }
    rememberObjectQueryReads(undefined, { kind: "page", pageSize: 10, input }, ["PlainPage"])

    for (const pageToken of [undefined, "next"]) {
      expect(
        objectQueryReadsAny(
          undefined,
          { kind: "page", pageSize: 10, ...(pageToken ? { pageToken } : {}), input },
          new Set(["Other"])
        )
      ).toBe(false)
    }
  })

  test("reads belong to the API client that answered", () => {
    const here = {}
    const there = {}
    rememberObjectQueryReads(here, query("Shared"), ["Shared"])
    rememberObjectQueryReads(there, query("Shared"), ["Shared", "Subtype"])

    expect(objectQueryReadsAny(here, query("Shared"), new Set(["Subtype"]))).toBe(false)
    expect(objectQueryReadsAny(there, query("Shared"), new Set(["Subtype"]))).toBe(true)
  })

  test("property order does not matter, as it does not to the cache", () => {
    rememberObjectQueryReads(undefined, { kind: "start", objectTypeId: "Ordered" }, ["Ordered"])

    expect(
      objectQueryReadsAny(undefined, { objectTypeId: "Ordered", kind: "start" }, new Set(["Other"]))
    ).toBe(false)
  })

  test("a query answering without its reads goes back to reading everything", () => {
    rememberObjectQueryReads(undefined, query("Forgotten"), ["Forgotten"])
    expect(objectQueryReadsAny(undefined, query("Forgotten"), new Set(["Site"]))).toBe(false)

    rememberObjectQueryReads(undefined, query("Forgotten"), undefined)
    expect(objectQueryReadsAny(undefined, query("Forgotten"), new Set(["Site"]))).toBe(true)
  })

  test("a key that is not a query counts as reading everything", () => {
    expect(objectQueryReadsAny(undefined, undefined, new Set(["Site"]))).toBe(true)
    expect(objectQueryReadsAny(undefined, "related", new Set(["Site"]))).toBe(true)
  })
})
