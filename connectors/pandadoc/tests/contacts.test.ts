import { afterEach, describe, expect, test } from "bun:test"
import { pandadoc } from "../src"
import { CONTEXT, json, mockFetch } from "./helpers"

describe("pandadoc contacts", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("list reads contacts in one unpaginated request, optionally filtered by exact email", async () => {
    const calls: { method: string; path: string; search: string }[] = []
    const contact = { id: "c1", email: "buyer@example.com", first_name: "Buyer" }

    mockFetch((input, init) => {
      const url = new URL(String(input))
      calls.push({ method: init?.method ?? "", path: url.pathname, search: url.search })
      return Promise.resolve(json({ results: [contact] }))
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    const response = await client.contacts.list()
    await client.contacts.list({ email: "buyer@example.com" })

    expect(calls).toEqual([
      { method: "GET", path: "/public/v1/contacts", search: "" },
      { method: "GET", path: "/public/v1/contacts", search: "?email=buyer%40example.com" },
    ])
    expect(response.results).toEqual([contact])
  })

  test("CRUD methods hit exact paths and methods", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    mockFetch((input, init) => {
      calls.push({
        method: init?.method ?? "",
        path: new URL(String(input)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Promise.resolve(
        init?.method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "c1" })
      )
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    await client.contacts.create({ email: "buyer@example.com", first_name: "Buyer" })
    await client.contacts.get("c1")
    await client.contacts.update("c1", { first_name: "Updated" })
    await client.contacts.delete("c1")

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/public/v1/contacts",
        body: { email: "buyer@example.com", first_name: "Buyer" },
      },
      { method: "GET", path: "/public/v1/contacts/c1" },
      { method: "PATCH", path: "/public/v1/contacts/c1", body: { first_name: "Updated" } },
      { method: "DELETE", path: "/public/v1/contacts/c1" },
    ])
  })
})
