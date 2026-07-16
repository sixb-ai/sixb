import { afterEach, describe, expect, test } from "bun:test"
import { collect, createTestClient, json, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("pennylane change logs", () => {
  test("reads each change log from its documented path", async () => {
    const paths: string[] = []
    mockFetch((input) => {
      paths.push(new URL(String(input)).pathname)
      return Promise.resolve(
        json({ items: [{ id: 1, operation: "update" }], has_more: false, next_cursor: null })
      )
    })

    const client = await createTestClient()
    await client.quoteChanges.list()
    await client.productChanges.list({ start_date: "2026-07-01T00:00:00Z" })
    await client.customerChanges.list({ limit: 1000 })

    expect(paths).toEqual([
      "/api/external/v2/changelogs/quotes",
      "/api/external/v2/changelogs/products",
      "/api/external/v2/changelogs/customers",
    ])
  })

  test("listAll seeds start_date on the first page then follows cursors", async () => {
    const requests: URL[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      requests.push(url)
      return Promise.resolve(
        json(
          requests.length === 1
            ? { items: [{ id: 1, operation: "insert" }], has_more: true, next_cursor: "c2" }
            : { items: [{ id: 2, operation: "delete" }], has_more: false, next_cursor: null }
        )
      )
    })

    const client = await createTestClient()
    const changes = await collect(
      client.productChanges.listAll({ start_date: "2026-07-01T00:00:00Z", limit: 1000 })
    )

    expect(changes.map((change) => change.id)).toEqual([1, 2])
    expect(requests[0]?.searchParams.get("start_date")).toBe("2026-07-01T00:00:00Z")
    expect(requests[0]?.searchParams.get("cursor")).toBeNull()
    expect(requests[1]?.searchParams.get("cursor")).toBe("c2")
    expect(requests[1]?.searchParams.get("start_date")).toBeNull()
  })

  test("rejects cursor with start_date and enforces the 1000 limit per resource", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(json({ items: [], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient()
    expect(() =>
      client.customerChanges.list({ cursor: "c", start_date: "2026-07-01T00:00:00Z" } as never)
    ).toThrow("customer changes cursor and start_date are mutually exclusive")
    expect(() => client.productChanges.list({ limit: 1001 })).toThrow("between 1 and 1000")
    expect(calls).toBe(0)
  })
})
