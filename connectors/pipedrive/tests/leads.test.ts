import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { pipedrive } from "../src"
import { CONTEXT, collect, json, mockFetch } from "./helpers"

describe("pipedrive leads", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("list, get, search, and permittedUsers use v1 paths", async () => {
    const paths: string[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      paths.push(`${url.pathname}${url.search}`)
      return Promise.resolve(json({ success: true, data: [] }))
    })

    const client = await pipedrive({ apiToken: "t" }).connect(CONTEXT)
    await client.leads.list({ start: 0, limit: 100 })
    await client.leads.get("lead-1")
    await client.leads.search({ term: "acme", start: 10, limit: 10 })
    await client.leads.permittedUsers("lead-1")

    expect(paths).toEqual([
      "/v1/leads?start=0&limit=100",
      "/v1/leads/lead-1",
      "/v1/leads/search?term=acme&start=10&limit=10",
      "/v1/leads/lead-1/permittedUsers",
    ])
  })

  test("listAll follows v1 offset pagination", async () => {
    const starts: (string | null)[] = []
    mockFetch((input) => {
      const start = new URL(String(input)).searchParams.get("start")
      starts.push(start)
      return Promise.resolve(
        json(
          start === "2"
            ? {
                success: true,
                data: [{ id: "l2" }],
                additional_data: {
                  pagination: { start: 2, limit: 2, more_items_in_collection: false },
                },
              }
            : {
                success: true,
                data: [{ id: "l1" }],
                additional_data: {
                  pagination: {
                    start: 0,
                    limit: 2,
                    more_items_in_collection: true,
                    next_start: 2,
                  },
                },
              }
        )
      )
    })

    const client = await pipedrive({ apiToken: "t" }).connect(CONTEXT)
    const leads = await collect(client.leads.listAll({ limit: 2 }))

    expect(starts).toEqual(["0", "2"])
    expect(leads.map((lead) => lead.id)).toEqual(["l1", "l2"])
  })
})
