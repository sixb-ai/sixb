import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { pipedrive } from "../src"
import { CONTEXT, json, mockFetch } from "./helpers"

describe("pipedrive organizations", () => {
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
    await client.organizations.create({
      name: "Buyer Organization",
      address: { value: "123 Main St, Miami, FL 33101" },
      visible_to: 3,
      label_ids: [10, 20],
    })
    await client.organizations.update(123, {
      name: "Updated Buyer Organization",
      address: { value: "456 Main St, Miami, FL 33101" },
    })

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v2/organizations",
        body: {
          name: "Buyer Organization",
          address: { value: "123 Main St, Miami, FL 33101" },
          visible_to: 3,
          label_ids: [10, 20],
        },
      },
      {
        method: "PATCH",
        path: "/api/v2/organizations/123",
        body: {
          name: "Updated Buyer Organization",
          address: { value: "456 Main St, Miami, FL 33101" },
        },
      },
    ])
  })
})
