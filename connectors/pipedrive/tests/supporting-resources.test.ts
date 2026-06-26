import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { pipedrive } from "../src"
import { CONTEXT, json, mockFetch } from "./helpers"

describe("pipedrive supporting resources", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("notes map to v1 read endpoints", async () => {
    const paths: string[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      paths.push(`${url.pathname}${url.search}`)
      return Promise.resolve(json({ success: true, data: [] }))
    })

    const client = await pipedrive({ apiToken: "t" }).connect(CONTEXT)
    await client.notes.list({ deal_id: 42, limit: 50 })
    await client.notes.get(7)
    await client.notes.listComments(7, { start: 0, limit: 10 })
    await client.notes.getComment(7, 9)

    expect(paths).toEqual([
      "/v1/notes?deal_id=42&limit=50",
      "/v1/notes/7",
      "/v1/notes/7/comments?start=0&limit=10",
      "/v1/notes/7/comments/9",
    ])
  })

  test("files expose metadata reads without download", async () => {
    const paths: string[] = []
    mockFetch((input) => {
      paths.push(new URL(String(input)).pathname)
      return Promise.resolve(json({ success: true, data: [] }))
    })

    const client = await pipedrive({ apiToken: "t" }).connect(CONTEXT)
    await client.files.list({ deal_id: 42 })
    await client.files.get(5)

    expect(paths).toEqual(["/v1/files", "/v1/files/5"])
    expect(paths.some((path) => path.includes("download"))).toBe(false)
  })

  test("users map to v1 read endpoints", async () => {
    const paths: string[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      paths.push(`${url.pathname}${url.search}`)
      return Promise.resolve(json({ success: true, data: [] }))
    })

    const client = await pipedrive({ apiToken: "t" }).connect(CONTEXT)
    await client.users.list({ limit: 100 })
    await client.users.me()
    await client.users.get(3)
    await client.users.find({ term: "camden", search_by_email: true })

    expect(paths).toEqual([
      "/v1/users?limit=100",
      "/v1/users/me",
      "/v1/users/3",
      "/v1/users/find?term=camden&search_by_email=1",
    ])
  })

  test("item search maps v2 search-by-field parameters", async () => {
    const paths: string[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      paths.push(`${url.pathname}${url.search}`)
      return Promise.resolve(json({ success: true, data: [] }))
    })

    const client = await pipedrive({ apiToken: "t" }).connect(CONTEXT)
    await client.itemSearch.searchByField({
      term: "roof",
      entity_type: "deal",
      field: "title",
      match: "middle",
      limit: 10,
    })

    expect(paths).toEqual([
      "/api/v2/itemSearch/field?term=roof&entity_type=deal&field=title&match=middle&limit=10",
    ])
  })
})
