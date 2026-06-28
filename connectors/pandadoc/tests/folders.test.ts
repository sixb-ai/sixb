import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { pandadoc } from "../src"
import { CONTEXT, json, mockFetch } from "./helpers"

describe("pandadoc folders", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("uses separate document and template folder paths", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    mockFetch((input, init) => {
      calls.push({
        method: init?.method ?? "",
        path: new URL(String(input)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Promise.resolve(json({ results: [], uuid: "folder1", name: "Folder" }))
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    await client.folders.documents.list()
    await client.folders.documents.create({ name: "Docs" })
    await client.folders.templates.list()
    await client.folders.templates.rename("tpl-folder", { name: "Templates" })

    expect(calls).toEqual([
      { method: "GET", path: "/public/v1/documents/folders" },
      { method: "POST", path: "/public/v1/documents/folders", body: { name: "Docs" } },
      { method: "GET", path: "/public/v1/templates/folders" },
      {
        method: "PUT",
        path: "/public/v1/templates/folders/tpl-folder",
        body: { name: "Templates" },
      },
    ])
  })
})
