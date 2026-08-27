import { afterEach, describe, expect, test } from "bun:test"
import Stripe from "stripe"
import { stripe } from "../src"
import { API_KEY, CONTEXT, collect, createTestClient, json, mockFetch, recorder } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("stripe connector", () => {
  test("exposes only the five supported resource groups", async () => {
    mockFetch(async () => json({}))
    const client = await createTestClient()

    expect(Object.keys(client)).toEqual([
      "customers",
      "subscriptions",
      "invoices",
      "refunds",
      "events",
    ])
  })

  test("resolves an async API key when Sixb connects the adapter", async () => {
    let resolutions = 0
    mockFetch(async () => json({ object: "list", data: [], has_more: false, url: "/v1/events" }))
    const client = await stripe({
      apiKey: async () => {
        resolutions += 1
        return API_KEY
      },
      maxNetworkRetries: 0,
    }).connect(CONTEXT)

    await client.events.list()

    expect(resolutions).toBe(1)
  })

  test("does not connect after the Sixb lifecycle signal has been aborted", async () => {
    const controller = new AbortController()
    controller.abort(new DOMException("stopped", "AbortError"))

    await expect(
      stripe({ apiKey: API_KEY }).connect({ ...CONTEXT, signal: controller.signal })
    ).rejects.toThrow("stopped")
  })

  test("validates connector options before constructing the SDK", () => {
    expect(() => stripe({ apiKey: " " })).toThrow("apiKey must not be empty")
    expect(() => stripe({ apiKey: 42 as unknown as string })).toThrow(
      "apiKey must be a string or a function"
    )
    expect(() => stripe({ apiKey: API_KEY, maxNetworkRetries: -1 })).toThrow(
      "maxNetworkRetries must be a non-negative integer"
    )
    expect(() => stripe({ apiKey: API_KEY, timeoutMs: 0 })).toThrow(
      "timeoutMs must be a positive finite number"
    )
    expect(() => stripe({ apiKey: API_KEY, stripeContext: " " })).toThrow(
      "stripeContext must not be empty"
    )
  })
})

describe("customers", () => {
  test("uses Stripe form encoding, auth, response metadata, and an explicit idempotency key", async () => {
    const calls = recorder([
      json({ id: "cus_1", object: "customer", email: "ada@example.com", metadata: {} }),
    ])
    const client = await createTestClient()

    const customer = await client.customers.create(
      { email: "ada@example.com", metadata: { source: "sixb" } },
      { idempotencyKey: "customer:ada" }
    )

    expect(customer.id).toBe("cus_1")
    expect(customer.lastResponse.requestId).toBe("req_test")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/customers")
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`)
    expect(calls[0]?.headers.get("idempotency-key")).toBe("customer:ada")
    expect(calls[0]?.headers.get("content-type")).toStartWith("application/x-www-form-urlencoded")
    const body = new URLSearchParams(calls[0]?.body)
    expect(body.get("email")).toBe("ada@example.com")
    expect(body.get("metadata[source]")).toBe("sixb")
  })

  test("maps get, update, delete, list, and search to the documented endpoints", async () => {
    const calls = recorder([
      json({ id: "cus_1", object: "customer", metadata: {} }),
      json({ id: "cus_1", object: "customer", metadata: {} }),
      json({ id: "cus_1", object: "customer", deleted: true }),
      json({ object: "list", data: [], has_more: false, url: "/v1/customers" }),
      json({
        object: "search_result",
        data: [],
        has_more: false,
        next_page: null,
        url: "/v1/customers/search",
      }),
    ])
    const client = await createTestClient()

    await client.customers.get("cus_1")
    await client.customers.update("cus_1", { description: "Primary" })
    await client.customers.delete("cus_1")
    await client.customers.list({ email: "ada@example.com", limit: 25 })
    await client.customers.search({ query: "email:'ada@example.com'", limit: 10 })

    expect(calls.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["GET", "/v1/customers/cus_1"],
      ["POST", "/v1/customers/cus_1"],
      ["DELETE", "/v1/customers/cus_1"],
      ["GET", "/v1/customers"],
      ["GET", "/v1/customers/search"],
    ])
    expect(new URL(calls[3]?.url ?? "").searchParams.get("email")).toBe("ada@example.com")
    expect(new URL(calls[4]?.url ?? "").searchParams.get("query")).toBe("email:'ada@example.com'")
  })

  test("listAll follows Stripe's starting_after cursor", async () => {
    const calls = recorder((request) => {
      const startingAfter = new URL(request.url).searchParams.get("starting_after")
      return startingAfter
        ? json({
            object: "list",
            data: [{ id: "cus_2", object: "customer", metadata: {} }],
            has_more: false,
            url: "/v1/customers",
          })
        : json({
            object: "list",
            data: [{ id: "cus_1", object: "customer", metadata: {} }],
            has_more: true,
            url: "/v1/customers",
          })
    })
    const client = await createTestClient()

    const customers = await collect(client.customers.listAll({ limit: 1 }))

    expect(customers.map(({ id }) => id)).toEqual(["cus_1", "cus_2"])
    expect(new URL(calls[1]?.url ?? "").searchParams.get("starting_after")).toBe("cus_1")
  })

  test("rejects invalid cursors, limits, and ids before issuing a request", async () => {
    const calls = recorder([])
    const client = await createTestClient()

    expect(() =>
      client.customers.list({ starting_after: "cus_1", ending_before: "cus_2" })
    ).toThrow("mutually exclusive")
    expect(() => client.customers.list({ limit: 101 })).toThrow("between 1 and 100")
    expect(() => client.customers.get(" ")).toThrow("customer id must not be empty")
    expect(calls).toHaveLength(0)
  })
})

describe("subscriptions, invoices, refunds, and events", () => {
  test("maps representative writes and reads for every resource", async () => {
    const calls = recorder([
      json({ id: "sub_1", object: "subscription" }),
      json({ id: "sub_1", object: "subscription" }),
      json({ id: "in_1", object: "invoice" }),
      json({ id: "in_1", object: "invoice" }),
      json({ id: "re_1", object: "refund" }),
      json({ id: "re_1", object: "refund" }),
      json({ id: "evt_1", object: "event", type: "invoice.paid", data: {} }),
    ])
    const client = await createTestClient()

    await client.subscriptions.create({ customer: "cus_1" })
    await client.subscriptions.cancel("sub_1", { invoice_now: true })
    await client.invoices.create({ customer: "cus_1" })
    await client.invoices.finalize("in_1", { auto_advance: false })
    await client.refunds.create({ payment_intent: "pi_1", amount: 500 })
    await client.refunds.cancel("re_1")
    await client.events.get("evt_1")

    expect(calls.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["POST", "/v1/subscriptions"],
      ["DELETE", "/v1/subscriptions/sub_1"],
      ["POST", "/v1/invoices"],
      ["POST", "/v1/invoices/in_1/finalize"],
      ["POST", "/v1/refunds"],
      ["POST", "/v1/refunds/re_1/cancel"],
      ["GET", "/v1/events/evt_1"],
    ])
  })

  test("validates the event type filters documented by Stripe", async () => {
    const calls = recorder([])
    const client = await createTestClient()

    expect(() => client.events.list({ type: "invoice.paid", types: ["customer.created"] })).toThrow(
      "type or types"
    )
    expect(() =>
      client.events.list({ types: Array.from({ length: 21 }, () => "invoice.paid") })
    ).toThrow("at most 20")
    expect(calls).toHaveLength(0)
  })

  test("surfaces Stripe's structured API errors without losing request metadata", async () => {
    recorder([
      json(
        {
          error: {
            type: "invalid_request_error",
            code: "resource_missing",
            message: "No such customer: 'cus_missing'",
            param: "id",
          },
        },
        { status: 404, headers: { "request-id": "req_missing" } }
      ),
    ])
    const client = await createTestClient()

    const caught: unknown = await client.customers.get("cus_missing").catch((error) => error)

    expect(caught).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError)
    if (!(caught instanceof Stripe.errors.StripeInvalidRequestError)) throw caught

    expect(caught.statusCode).toBe(404)
    expect(caught.requestId).toBe("req_missing")
    expect(caught.code).toBe("resource_missing")
    expect(caught.param).toBe("id")
  })
})
