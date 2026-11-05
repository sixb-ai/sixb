import { afterEach, describe, expect, test } from "bun:test"
import { FleetioApiError, FleetioConfigurationError, fleetio } from "../src"
import { CONTEXT, createTestClient, empty, json, mockFetch, page, recorder, route } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("requests", () => {
  test("send both credentials, the pinned version, and the unversioned base path", async () => {
    const calls = recorder([page([])])
    const fl = await createTestClient()

    await fl.workOrders.list()

    expect(route(calls[0]!)).toBe("GET /api/work_orders")
    expect(calls[0]?.url.origin).toBe("https://secure.fleetio.com")
    expect(calls[0]?.headers.get("authorization")).toBe("Token key")
    expect(calls[0]?.headers.get("account-token")).toBe("account")
    expect(calls[0]?.headers.get("x-api-version")).toBe("2025-05-05")
    expect(calls[0]?.headers.get("accept")).toBe("application/json")
  })

  test("resolve credentials on each attempt and honor apiVersion and baseUrl", async () => {
    const calls = recorder([page([]), page([])])
    let rotation = 0
    const fl = await createTestClient({
      apiKey: async () => `key-${++rotation}`,
      apiVersion: "2024-06-30",
      baseUrl: "https://example.test/api",
    })

    await fl.workOrders.list()
    await fl.workOrders.list()

    expect(calls[1]?.url.href).toBe("https://example.test/api/work_orders")
    expect(calls[1]?.headers.get("authorization")).toBe("Token key-2")
    expect(calls[1]?.headers.get("x-api-version")).toBe("2024-06-30")
  })

  test("reject empty credentials before any request", async () => {
    expect(() => fleetio({ apiKey: " ", accountToken: "account" })).toThrow(
      FleetioConfigurationError
    )
    expect(() => fleetio({ apiKey: "key", accountToken: "" })).toThrow("accountToken")
    expect(() => fleetio({ apiKey: "key", accountToken: "a", apiVersion: " " })).toThrow(
      "apiVersion"
    )
  })

  test("do not retry a resolver that returns nothing", async () => {
    const calls = recorder([])
    const fl = await createTestClient({ accountToken: () => "" })

    const error = await fl.workOrders.list().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FleetioConfigurationError)
    expect(calls).toHaveLength(0)
  })

  test("reject an out-of-range page size before any request", async () => {
    const calls = recorder([])
    const fl = await createTestClient()

    expect(() => fl.workOrders.list({ pageSize: 101 })).toThrow("between 1 and 100")
    expect(() => fl.workOrders.list({ pageSize: 0 })).toThrow("between 1 and 100")
    expect(calls).toHaveLength(0)
  })

  test("encode a path segment and reject an empty one", async () => {
    const calls = recorder([json({ id: 1 })])
    const fl = await createTestClient()

    await fl.workOrders.get("a/b")

    expect(calls[0]?.url.pathname).toBe("/api/work_orders/a%2Fb")
    expect(() => fl.workOrders.get(" ")).toThrow("work order id must not be empty")
    expect(() => fl.workOrders.get(1.5)).toThrow("work order id must be a positive integer")
  })
})

describe("error bodies", () => {
  test.each([
    [
      "field errors on a 422",
      () => json({ errors: { name: ["can't be blank"], meter: ["a", "b"] } }, { status: 422 }),
      {
        status: 422,
        message:
          "[SixbFleetio] Fleetio API request failed with 422: name: can't be blank; meter: a, b",
        validationErrors: { name: ["can't be blank"], meter: ["a", "b"] },
        retryAfterMs: null,
      },
    ],
    [
      "problem details on a 404",
      () => json({ status: 404, title: "Not Found", detail: "No such record" }, { status: 404 }),
      {
        status: 404,
        message: "[SixbFleetio] Fleetio API request failed with 404: Not Found: No such record",
        validationErrors: null,
      },
    ],
    [
      "an empty 403",
      () => empty(403),
      {
        status: 403,
        message: "[SixbFleetio] Fleetio API request failed with 403.",
        responseBody: undefined,
      },
    ],
    [
      "the error string on a 429",
      () => json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": "7" } }),
      {
        status: 429,
        message: "[SixbFleetio] Fleetio API request failed with 429: Too many requests",
        retryAfterMs: 7000,
      },
    ],
  ])("surface %s", async (_name, response, expected) => {
    mockFetch(async () => response())
    const fl = await createTestClient({ retry: { maxRetries: 0 } })

    const error = await fl.workOrders.get(1).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FleetioApiError)
    expect(error).toMatchObject(expected)
  })
})

describe("retries", () => {
  const rateLimited = () =>
    json({ error: "slow" }, { status: 429, headers: { "retry-after": "0" } })

  test.each([
    ["a 429", rateLimited],
    [
      "a 500",
      () => json({ status: 500, title: "Oops" }, { status: 500, headers: { "retry-after": "0" } }),
    ],
  ])("a read retries %s", async (_name, failure) => {
    const calls = recorder([failure(), page([])])
    const fl = await createTestClient()

    await fl.workOrders.list()

    expect(calls).toHaveLength(2)
  })

  test("a write retries a 429, which means the request was refused", async () => {
    const calls = recorder([rateLimited(), json({ id: 1 }, { status: 201 })])
    const fl = await createTestClient()

    const created = await fl.workOrders.create({
      vehicle_id: 1,
      work_order_status_id: 2,
      issued_at: "2026-11-05T09:00:00Z",
    })

    expect(created.id).toBe(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body).toEqual(calls[0]?.body)
  })

  test("a write does not retry a 500, which may have been processed", async () => {
    const calls = recorder([json({ title: "Oops" }, { status: 500 })])
    const fl = await createTestClient()

    const error = await fl.workOrders.delete(1).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FleetioApiError)
    expect(calls).toHaveLength(1)
  })

  test("a write does not retry a network error", async () => {
    let attempts = 0
    mockFetch(async () => {
      attempts += 1
      throw new TypeError("connection reset")
    })
    const fl = await createTestClient()

    const error = await fl.workOrders.delete(1).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TypeError)
    expect(attempts).toBe(1)
  })

  test("stops at maxRetries and reports the last response", async () => {
    const calls = recorder(() => rateLimited())
    const fl = await createTestClient({ retry: { maxRetries: 1 } })

    const error = await fl.workOrders.list().catch((caught: unknown) => caught)

    expect(error).toMatchObject({ status: 429 })
    expect(calls).toHaveLength(2)
  })

  test("a custom policy replaces the default and sees the request's safety", async () => {
    const seen: boolean[] = []
    const calls = recorder([rateLimited()])
    const fl = await createTestClient({
      retry: {
        shouldRetry(context) {
          seen.push(context.idempotent)
          return false
        },
      },
    })

    await fl.workOrders.list().catch(() => undefined)

    expect(calls).toHaveLength(1)
    expect(seen).toEqual([true])
  })

  test("rejects an invalid retry count when connecting", async () => {
    const error = await Promise.resolve(
      fleetio({ apiKey: "key", accountToken: "account", retry: { maxRetries: -1 } }).connect(
        CONTEXT
      )
    ).catch((caught: unknown) => caught)

    expect(String(error)).toContain("retry.maxRetries")
  })
})
