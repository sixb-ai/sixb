import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { pandadoc } from "../src"
import { CONTEXT, collect, json, mockFetch } from "./helpers"

describe("pandadoc templates", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("listAll follows page pagination and preserves filters", async () => {
    const requested: string[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      requested.push(`${url.pathname}${url.search}`)
      return Promise.resolve(
        json({
          results: url.searchParams.get("page") === "1" ? [{ id: "tpl1" }] : [],
        })
      )
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    const templates = await collect(client.templates.listAll({ count: 1, tag: ["sales", "legal"] }))

    expect(requested).toEqual([
      "/public/v1/templates?count=1&tag=sales&tag=legal&page=1",
      "/public/v1/templates?count=1&tag=sales&tag=legal&page=2",
    ])
    expect(templates.map((template) => template.id)).toEqual(["tpl1"])
  })

  test("status and details hit exact paths", async () => {
    const paths: string[] = []
    mockFetch((input) => {
      paths.push(new URL(String(input)).pathname)
      return Promise.resolve(json({ id: "tpl1" }))
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    await client.templates.status("tpl1")
    await client.templates.details("tpl1")

    expect(paths).toEqual(["/public/v1/templates/tpl1", "/public/v1/templates/tpl1/details"])
  })
})
