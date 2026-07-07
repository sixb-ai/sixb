import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { pipedrive } from "../src"
import { CONTEXT, json, mockFetch } from "./helpers"

describe("pipedrive persons", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("create and update hit exact v2 paths and methods", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    mockFetch((input, init) => {
      calls.push({
        method: init?.method ?? "",
        path: new URL(String(input)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Promise.resolve(json({ success: true, data: { id: 123 } }))
    })

    const client = await pipedrive({ apiToken: "pd-token" }).connect(CONTEXT)
    await client.persons.create({
      name: "Buyer Person",
      org_id: 42,
      emails: [{ value: "buyer@example.com", primary: true, label: "work" }],
      phones: [{ value: "+1-555-123-4567", primary: true, label: "work" }],
    })
    await client.persons.update(123, {
      name: "Updated Buyer",
      emails: [{ value: "updated@example.com", primary: true }],
    })

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v2/persons",
        body: {
          name: "Buyer Person",
          org_id: 42,
          emails: [{ value: "buyer@example.com", primary: true, label: "work" }],
          phones: [{ value: "+1-555-123-4567", primary: true, label: "work" }],
        },
      },
      {
        method: "PATCH",
        path: "/api/v2/persons/123",
        body: {
          name: "Updated Buyer",
          emails: [{ value: "updated@example.com", primary: true }],
        },
      },
    ])
  })
})
