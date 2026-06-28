import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { pandadoc } from "../src"
import { CONTEXT, json, mockFetch } from "./helpers"

describe("pandadoc contacts", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
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
