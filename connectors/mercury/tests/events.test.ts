import { afterEach, expect, test } from "bun:test"
import { collect, createTestClient, json, query, recorder } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function event(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    resourceType: "transaction",
    resourceId: "t1",
    operationType: "update",
    resourceVersion: 2,
    occurredAt: "2026-07-26T00:00:00Z",
    changedPaths: ["status", "postedAt"],
    mergePatch: { status: "sent", postedAt: "2026-07-26T00:00:00Z" },
    previousValues: { status: "pending", postedAt: null },
    ...overrides,
  }
}

test("list filters by resource type and id", async () => {
  const calls = recorder([json({ events: [event("ev-1")], page: {} })])
  const mc = await createTestClient()

  const page = await mc.events.list({ resourceType: "transaction", resourceId: "t1", limit: 100 })

  expect(page.events[0]?.changedPaths).toEqual(["status", "postedAt"])
  expect(page.events[0]?.previousValues?.status).toBe("pending")
  const params = query(calls[0]?.url ?? "")
  expect(params.get("resourceType")).toBe("transaction")
  expect(params.get("resourceId")).toBe("t1")
  expect(params.get("limit")).toBe("100")
})

test("listAll resumes from the last event id, which is the incremental sync path", async () => {
  const calls = recorder([
    json({ events: [event("ev-2")], page: { nextPage: "ev-2" } }),
    json({ events: [event("ev-3")], page: {} }),
  ])
  const mc = await createTestClient()

  const events = await collect(mc.events.listAll({ start_after: "ev-1" }))

  expect(events.map((entry) => entry.id)).toEqual(["ev-2", "ev-3"])
  expect(query(calls[0]?.url ?? "").get("start_after")).toBe("ev-1")
  expect(query(calls[1]?.url ?? "").get("start_after")).toBe("ev-2")
})

test("get reads a single event", async () => {
  const calls = recorder([json(event("ev-1"))])
  const mc = await createTestClient()

  const found = await mc.events.get("ev-1")

  expect(found.operationType).toBe("update")
  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/events/ev-1")
})

test("webhook endpoint registration returns the signing secret only on create", async () => {
  const calls = recorder([
    json({
      id: "wh-1",
      url: "https://example.com/hooks/mercury",
      status: "active",
      createdAt: "2026-07-26T00:00:00Z",
      updatedAt: "2026-07-26T00:00:00Z",
      eventTypes: ["transaction.created"],
      secret: "whsec_abc",
    }),
  ])
  const mc = await createTestClient()

  const endpoint = await mc.webhookEndpoints.create({
    url: "https://example.com/hooks/mercury",
    eventTypes: ["transaction.created"],
  })

  expect(endpoint.secret).toBe("whsec_abc")
  expect(calls[0]?.method).toBe("POST")
  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/webhooks")
})

test("webhook endpoint list repeats the status filter", async () => {
  const calls = recorder([json({ webhooks: [], page: {} })])
  const mc = await createTestClient()

  await mc.webhookEndpoints.list({ status: ["active", "disabled"] })

  expect(query(calls[0]?.url ?? "").getAll("status")).toEqual(["active", "disabled"])
})

test("verify posts an empty body by default", async () => {
  const calls = recorder([new Response(null, { status: 204 })])
  const mc = await createTestClient()

  await mc.webhookEndpoints.verify("wh-1")

  expect(calls[0]?.url).toBe("https://api.mercury.com/api/v1/webhooks/wh-1/verify")
  expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({})
})
