import { afterEach, describe, expect, test } from "bun:test"
import type { PipedriveClient } from "../src"
import { pipedrive } from "../src"
import { CONTEXT, json, mockFetch } from "./helpers"

describe("pipedrive supporting resources", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test.each<[string, (client: PipedriveClient) => Promise<void>, string[]]>([
    [
      "notes map to v1 read endpoints",
      async (client) => {
        await client.notes.list({ deal_id: 42, limit: 50 })
        await client.notes.get(7)
        await client.notes.listComments(7, { start: 0, limit: 10 })
        await client.notes.getComment(7, 9)
      },
      [
        "/v1/notes?deal_id=42&limit=50",
        "/v1/notes/7",
        "/v1/notes/7/comments?start=0&limit=10",
        "/v1/notes/7/comments/9",
      ],
    ],
    [
      "files expose metadata reads without download",
      async (client) => {
        await client.files.list({ deal_id: 42 })
        await client.files.get(5)
      },
      ["/v1/files?deal_id=42", "/v1/files/5"],
    ],
    [
      "users map to v1 read endpoints",
      async (client) => {
        await client.users.list({ limit: 100 })
        await client.users.me()
        await client.users.get(3)
        await client.users.find({ term: "camden", search_by_email: true })
      },
      [
        "/v1/users?limit=100",
        "/v1/users/me",
        "/v1/users/3",
        "/v1/users/find?term=camden&search_by_email=1",
      ],
    ],
    [
      "item search maps v2 search-by-field parameters",
      async (client) => {
        await client.itemSearch.searchByField({
          term: "roof",
          entity_type: "deal",
          field: "title",
          match: "middle",
          limit: 10,
        })
      },
      ["/api/v2/itemSearch/field?term=roof&entity_type=deal&field=title&match=middle&limit=10"],
    ],
  ])("%s", async (_name, run, expected) => {
    const paths: string[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      paths.push(`${url.pathname}${url.search}`)
      return Promise.resolve(json({ success: true, data: [] }))
    })

    await run(await pipedrive({ apiToken: "t" }).connect(CONTEXT))

    expect(paths).toEqual(expected)
  })
})
