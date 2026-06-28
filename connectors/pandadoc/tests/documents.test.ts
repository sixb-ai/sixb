import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { PandaDocApiError, pandadoc } from "../src"
import { CONTEXT, collect, json, mockFetch } from "./helpers"

describe("pandadoc documents", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("list sends API-key auth and serializes query params", async () => {
    let requested = ""
    let authorization = ""
    let accept = ""
    mockFetch((input, init) => {
      requested = String(input)
      const headers = new Headers(init?.headers)
      authorization = headers.get("authorization") ?? ""
      accept = headers.get("accept") ?? ""
      return Promise.resolve(json({ results: [] }))
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    await client.documents.list({
      count: 100,
      page: 2,
      q: "Services",
      status: "document.completed",
      metadata: ["metadata_deal_id=123", "metadata_source=pipedrive"],
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/public/v1/documents")
    expect(url.searchParams.get("count")).toBe("100")
    expect(url.searchParams.get("page")).toBe("2")
    expect(url.searchParams.get("q")).toBe("Services")
    expect(url.searchParams.get("status")).toBe("2")
    expect(url.searchParams.getAll("metadata")).toEqual([
      "metadata_deal_id=123",
      "metadata_source=pipedrive",
    ])
    expect(authorization).toBe("API-Key pd-key")
    expect(accept).toBe("application/json")
  })

  test("create, status, details, send, and status change hit exact paths", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    mockFetch((input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({
        method: init?.method ?? "",
        path: `${new URL(String(input)).pathname}${new URL(String(input)).search}`,
        body,
      })
      return Promise.resolve(
        init?.method === "PATCH" ? new Response(null, { status: 204 }) : json({ id: "doc 1" })
      )
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    await client.documents.create(
      { name: "Doc", template_uuid: "tpl" },
      { use_form_field_properties: true }
    )
    await client.documents.status("doc 1")
    await client.documents.details("doc 1")
    await client.documents.send("doc 1", { silent: true })
    await client.documents.changeStatus("doc 1", { status: 2, notify_recipients: false })

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/public/v1/documents?use_form_field_properties=true",
        body: { name: "Doc", template_uuid: "tpl" },
      },
      { method: "GET", path: "/public/v1/documents/doc%201" },
      { method: "GET", path: "/public/v1/documents/doc%201/details" },
      { method: "POST", path: "/public/v1/documents/doc%201/send", body: { silent: true } },
      {
        method: "PATCH",
        path: "/public/v1/documents/doc%201/status",
        body: { status: 2, notify_recipients: false },
      },
    ])
  })

  test("listAll follows page pagination", async () => {
    const pages: string[] = []
    mockFetch((input) => {
      const page = new URL(String(input)).searchParams.get("page") ?? ""
      pages.push(page)
      return Promise.resolve(
        json({
          results: page === "1" ? [{ id: "doc1" }, { id: "doc2" }] : [{ id: "doc3" }],
        })
      )
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    const documents = await collect(client.documents.listAll({ count: 2 }))

    expect(pages).toEqual(["1", "2"])
    expect(documents.map((document) => document.id)).toEqual(["doc1", "doc2", "doc3"])
  })

  test("download returns the raw response", async () => {
    let path = ""
    mockFetch((input) => {
      const url = new URL(String(input))
      path = `${url.pathname}${url.search}`
      return Promise.resolve(
        new Response("pdf-bytes", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })
      )
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    const response = await client.documents.downloadProtected("doc1", { separate_files: true })

    expect(path).toBe("/public/v1/documents/doc1/download-protected?separate_files=true")
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(await response.text()).toBe("pdf-bytes")
  })

  test("throws PandaDocApiError on non-2xx responses", async () => {
    mockFetch(() => Promise.resolve(json({ detail: "bad key" }, { status: 401 })))

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    const promise = client.documents.status("doc1")

    await expect(promise).rejects.toBeInstanceOf(PandaDocApiError)
    await expect(promise).rejects.toThrow("401")
    await expect(promise).rejects.toThrow("bad key")
  })
})
