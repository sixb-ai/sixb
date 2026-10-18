import { afterEach, describe, expect, test } from "bun:test"
import { pipedrive } from "../src"
import { CONTEXT, json, mockFetch } from "./helpers"

describe("pipedrive persons and organizations", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test.each([
    ["persons", { name: "Buyer Person", org_id: 42 }],
    ["organizations", { name: "Buyer Organization", label_ids: [10, 20] }],
  ] as const)("%s create and update hit exact v2 paths and methods", async (resource, input) => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    mockFetch((request, init) => {
      calls.push({
        method: init?.method ?? "",
        path: new URL(String(request)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Promise.resolve(json({ success: true, data: { id: 123 } }))
    })

    const client = await pipedrive({ apiToken: "pd-token" }).connect(CONTEXT)
    await client[resource].create(input)
    await client[resource].update(123, { name: "Updated" })

    expect(calls).toEqual([
      { method: "POST", path: `/api/v2/${resource}`, body: input },
      { method: "PATCH", path: `/api/v2/${resource}/123`, body: { name: "Updated" } },
    ])
  })
})
