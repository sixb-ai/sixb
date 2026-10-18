import { afterEach, describe, expect, test } from "bun:test"
import Stripe from "stripe"
import type { StripeClient } from "../src"
import { stripe } from "../src"
import { API_KEY, CONTEXT, collect, createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const account = { stripeAccount: "acct_1" }

describe("stripe connector", () => {
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

  test("resolves an async API key when Sixb connects the adapter and authenticates with it", async () => {
    let resolutions = 0
    const calls = recorder([json({ object: "list", data: [], has_more: false, url: "/v1/events" })])
    const client = await stripe({
      apiKey: async () => {
        resolutions += 1
        return API_KEY
      },
      maxNetworkRetries: 0,
    }).connect(CONTEXT)

    await client.events.list()

    expect(resolutions).toBe(1)
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`)
  })

  test("does not connect after the Sixb lifecycle signal has been aborted", async () => {
    const controller = new AbortController()
    controller.abort(new DOMException("stopped", "AbortError"))

    await expect(
      stripe({ apiKey: API_KEY }).connect({ ...CONTEXT, signal: controller.signal })
    ).rejects.toThrow("stopped")
  })

  test("surfaces Stripe's API errors unwrapped and honors maxNetworkRetries", async () => {
    const calls = recorder([
      json(
        { error: { type: "api_error", message: "Unavailable" } },
        { status: 500, headers: { "request-id": "req_failed" } }
      ),
    ])
    const client = await createTestClient({ maxNetworkRetries: 0 })

    const caught: unknown = await client.customers.get("cus_1").catch((error) => error)

    expect(caught).toBeInstanceOf(Stripe.errors.StripeAPIError)
    if (!(caught instanceof Stripe.errors.StripeAPIError)) throw caught
    expect(caught.statusCode).toBe(500)
    expect(caught.requestId).toBe("req_failed")
    // The SDK retries a 500 by default, so a single request proves the option reached it.
    expect(calls).toHaveLength(1)
  })
})

type ResourceCall = readonly [
  name: string,
  run: (client: StripeClient) => Promise<unknown>,
  method: string,
  path: string,
  param: readonly [key: string, value: string] | null,
]

// Every call passes Connect options, so the stripe-account header proves each method forwards them.
const resourceCalls: readonly ResourceCall[] = [
  [
    "customers.create",
    (c) => c.customers.create({ email: "ada@example.com", metadata: { source: "sixb" } }, account),
    "POST",
    "/v1/customers",
    ["metadata[source]", "sixb"],
  ],
  [
    "customers.get",
    (c) => c.customers.get("cus_1", { expand: ["default_source"] }, account),
    "GET",
    "/v1/customers/cus_1",
    ["expand[0]", "default_source"],
  ],
  [
    "customers.update",
    (c) => c.customers.update("cus_1", { description: "Primary" }, account),
    "POST",
    "/v1/customers/cus_1",
    ["description", "Primary"],
  ],
  [
    "customers.delete",
    (c) => c.customers.delete("cus_1", {}, account),
    "DELETE",
    "/v1/customers/cus_1",
    null,
  ],
  [
    "customers.list",
    (c) => c.customers.list({ email: "ada@example.com", limit: 25 }, account),
    "GET",
    "/v1/customers",
    ["email", "ada@example.com"],
  ],
  [
    "customers.listAll",
    (c) => collect(c.customers.listAll({ email: "ada@example.com" }, account)),
    "GET",
    "/v1/customers",
    ["email", "ada@example.com"],
  ],
  [
    "customers.search",
    (c) => c.customers.search({ query: "email:'ada@example.com'", limit: 10 }, account),
    "GET",
    "/v1/customers/search",
    ["query", "email:'ada@example.com'"],
  ],
  [
    "subscriptions.create",
    (c) => c.subscriptions.create({ customer: "cus_1" }, account),
    "POST",
    "/v1/subscriptions",
    ["customer", "cus_1"],
  ],
  [
    "subscriptions.cancel",
    (c) => c.subscriptions.cancel("sub_1", { invoice_now: true }, account),
    "DELETE",
    "/v1/subscriptions/sub_1",
    ["invoice_now", "true"],
  ],
  [
    "invoices.create",
    (c) => c.invoices.create({ customer: "cus_1" }, account),
    "POST",
    "/v1/invoices",
    ["customer", "cus_1"],
  ],
  [
    "invoices.finalize",
    (c) => c.invoices.finalize("in_1", { auto_advance: false }, account),
    "POST",
    "/v1/invoices/in_1/finalize",
    ["auto_advance", "false"],
  ],
  [
    "invoices.updateLineItem",
    (c) => c.invoices.updateLineItem("in_1", "il_1", { amount: -500 }, account),
    "POST",
    "/v1/invoices/in_1/lines/il_1",
    ["amount", "-500"],
  ],
  [
    "invoices.addLines",
    (c) =>
      c.invoices.addLines("in_1", { lines: [{ amount: -500, description: "Credit" }] }, account),
    "POST",
    "/v1/invoices/in_1/add_lines",
    ["lines[0][amount]", "-500"],
  ],
  [
    "invoices.updateLines",
    (c) => c.invoices.updateLines("in_1", { lines: [{ id: "il_1", amount: 700 }] }, account),
    "POST",
    "/v1/invoices/in_1/update_lines",
    ["lines[0][amount]", "700"],
  ],
  [
    "invoices.removeLines",
    (c) =>
      c.invoices.removeLines("in_1", { lines: [{ id: "il_1", behavior: "unassign" }] }, account),
    "POST",
    "/v1/invoices/in_1/remove_lines",
    ["lines[0][behavior]", "unassign"],
  ],
  [
    "invoices.listLineItems",
    (c) => c.invoices.listLineItems("in_1", { limit: 1 }, account),
    "GET",
    "/v1/invoices/in_1/lines",
    ["limit", "1"],
  ],
  [
    "invoices.listAllLineItems",
    (c) => collect(c.invoices.listAllLineItems("in_1", { expand: ["data.discounts"] }, account)),
    "GET",
    "/v1/invoices/in_1/lines",
    ["expand[0]", "data.discounts"],
  ],
  [
    "invoicePayments.get",
    (c) => c.invoicePayments.get("inpay_1", { expand: ["payment.payment_intent"] }, account),
    "GET",
    "/v1/invoice_payments/inpay_1",
    ["expand[0]", "payment.payment_intent"],
  ],
  [
    "invoicePayments.list",
    (c) => c.invoicePayments.list({ invoice: "in_1" }, account),
    "GET",
    "/v1/invoice_payments",
    ["invoice", "in_1"],
  ],
  [
    "invoicePayments.listAll",
    (c) =>
      collect(
        c.invoicePayments.listAll(
          { payment: { type: "payment_intent", payment_intent: "pi_1" } },
          account
        )
      ),
    "GET",
    "/v1/invoice_payments",
    ["payment[payment_intent]", "pi_1"],
  ],
  [
    "paymentIntents.create",
    (c) =>
      c.paymentIntents.create(
        { amount: 2500, currency: "eur", automatic_payment_methods: { enabled: true } },
        account
      ),
    "POST",
    "/v1/payment_intents",
    ["automatic_payment_methods[enabled]", "true"],
  ],
  [
    "paymentIntents.update",
    (c) => c.paymentIntents.update("pi_1", { metadata: { order: "order_2" } }, account),
    "POST",
    "/v1/payment_intents/pi_1",
    ["metadata[order]", "order_2"],
  ],
  [
    "paymentIntents.confirm",
    (c) => c.paymentIntents.confirm("pi_1", { payment_method: "pm_1" }, account),
    "POST",
    "/v1/payment_intents/pi_1/confirm",
    ["payment_method", "pm_1"],
  ],
  [
    "paymentIntents.capture",
    (c) => c.paymentIntents.capture("pi_1", { amount_to_capture: 1500 }, account),
    "POST",
    "/v1/payment_intents/pi_1/capture",
    ["amount_to_capture", "1500"],
  ],
  [
    "paymentIntents.cancel",
    (c) =>
      c.paymentIntents.cancel("pi_1", { cancellation_reason: "requested_by_customer" }, account),
    "POST",
    "/v1/payment_intents/pi_1/cancel",
    ["cancellation_reason", "requested_by_customer"],
  ],
  [
    "paymentIntents.incrementAuthorization",
    (c) => c.paymentIntents.incrementAuthorization("pi_1", { amount: 3000 }, account),
    "POST",
    "/v1/payment_intents/pi_1/increment_authorization",
    ["amount", "3000"],
  ],
  [
    "paymentIntents.applyCustomerBalance",
    (c) => c.paymentIntents.applyCustomerBalance("pi_1", { amount: 500 }, account),
    "POST",
    "/v1/payment_intents/pi_1/apply_customer_balance",
    ["amount", "500"],
  ],
  [
    "paymentIntents.verifyMicrodeposits",
    (c) => c.paymentIntents.verifyMicrodeposits("pi_1", { descriptor_code: "SM1234" }, account),
    "POST",
    "/v1/payment_intents/pi_1/verify_microdeposits",
    ["descriptor_code", "SM1234"],
  ],
  [
    "paymentIntents.get",
    (c) => c.paymentIntents.get("pi_1", { expand: ["latest_charge"] }, account),
    "GET",
    "/v1/payment_intents/pi_1",
    ["expand[0]", "latest_charge"],
  ],
  [
    "paymentIntents.list",
    (c) => c.paymentIntents.list({ customer: "cus_1" }, account),
    "GET",
    "/v1/payment_intents",
    ["customer", "cus_1"],
  ],
  [
    "paymentIntents.listAll",
    (c) => collect(c.paymentIntents.listAll({ customer: "cus_1" }, account)),
    "GET",
    "/v1/payment_intents",
    ["customer", "cus_1"],
  ],
  [
    "paymentIntents.search",
    (c) => c.paymentIntents.search({ query: "metadata['order']:'order_1'" }, account),
    "GET",
    "/v1/payment_intents/search",
    ["query", "metadata['order']:'order_1'"],
  ],
  [
    "paymentIntents.searchAll",
    (c) => collect(c.paymentIntents.searchAll({ query: "status:'succeeded'" }, account)),
    "GET",
    "/v1/payment_intents/search",
    ["query", "status:'succeeded'"],
  ],
  [
    "paymentIntents.listAmountDetailsLineItems",
    (c) => c.paymentIntents.listAmountDetailsLineItems("pi_1", { limit: 1 }, account),
    "GET",
    "/v1/payment_intents/pi_1/amount_details_line_items",
    ["limit", "1"],
  ],
  [
    "paymentIntents.listAllAmountDetailsLineItems",
    (c) => collect(c.paymentIntents.listAllAmountDetailsLineItems("pi_1", { limit: 2 }, account)),
    "GET",
    "/v1/payment_intents/pi_1/amount_details_line_items",
    ["limit", "2"],
  ],
  [
    "charges.get",
    (c) => c.charges.get("ch_1", { expand: ["balance_transaction"] }, account),
    "GET",
    "/v1/charges/ch_1",
    ["expand[0]", "balance_transaction"],
  ],
  [
    "charges.update",
    (c) => c.charges.update("ch_1", { receipt_email: "customer@example.com" }, account),
    "POST",
    "/v1/charges/ch_1",
    ["receipt_email", "customer@example.com"],
  ],
  [
    "refunds.create",
    (c) => c.refunds.create({ payment_intent: "pi_1", amount: 500 }, account),
    "POST",
    "/v1/refunds",
    ["payment_intent", "pi_1"],
  ],
  [
    "refunds.cancel",
    (c) => c.refunds.cancel("re_1", { expand: ["charge"] }, account),
    "POST",
    "/v1/refunds/re_1/cancel",
    ["expand[0]", "charge"],
  ],
  [
    "events.get",
    (c) => c.events.get("evt_1", { expand: ["data.object"] }, account),
    "GET",
    "/v1/events/evt_1",
    ["expand[0]", "data.object"],
  ],
]

describe("resources", () => {
  test.each(
    resourceCalls
  )("%s forwards its parameters and request options to the documented endpoint", async (_name, run, method, path, param) => {
    // One body serves objects and single-page lists: iterators stop at `has_more: false`.
    const calls = recorder(() =>
      json({ id: "obj_1", object: "list", data: [], has_more: false, url: path })
    )
    const client = await createTestClient()

    await run(client)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    const url = new URL(call.url)
    expect([call.method, url.pathname]).toEqual([method, path])
    expect(call.headers.get("stripe-account")).toBe("acct_1")
    if (param) {
      const sent = method === "POST" ? new URLSearchParams(call.body) : url.searchParams
      expect(sent.get(param[0])).toBe(param[1])
    }
  })

  for (const search of [false, true]) {
    test(
      search
        ? "charges search pages and searchAll retain the query and account"
        : "charges list pages and listAll retain all filters and account",
      async () => {
        const path = search ? "/v1/charges/search" : "/v1/charges"
        const calls = recorder((request) => {
          const second = new URL(request.url).searchParams.has(search ? "page" : "starting_after")
          return json({
            object: search ? "search_result" : "list",
            url: path,
            data: [{ id: second ? "ch_2" : "ch_1", object: "charge" }],
            has_more: !second,
            ...(search ? { next_page: second ? null : "next_token" } : {}),
          })
        })
        const client = await createTestClient()
        const params = {
          limit: 1,
          customer: "cus_1",
          payment_intent: "pi_1",
          created: { gte: 1700000000 },
          transfer_group: "order_1",
        }
        const searchParams = { query: "metadata['order']:'123'", limit: 1 }
        const page = await (search
          ? client.charges.search(searchParams, account)
          : client.charges.list(params, account))
        expect(page.data.map((item) => item.id)).toEqual(["ch_1"])
        const items = await collect(
          search
            ? client.charges.searchAll(searchParams, account)
            : client.charges.listAll(params, account)
        )
        expect(items.map((item) => item.id)).toEqual(["ch_1", "ch_2"])
        expect(calls).toHaveLength(3)
        expect(new URL(calls[2]!.url).searchParams.get(search ? "page" : "starting_after")).toBe(
          search ? "next_token" : "ch_1"
        )
        for (const call of calls) {
          const url = new URL(call.url)
          expect(call.method).toBe("GET")
          expect(url.pathname).toBe(path)
          expect(url.searchParams.get("limit")).toBe("1")
          expect(call.headers.get("stripe-account")).toBe("acct_1")
          if (search) {
            expect(url.searchParams.get("query")).toBe(searchParams.query)
          } else {
            expect(url.searchParams.get("customer")).toBe("cus_1")
            expect(url.searchParams.get("payment_intent")).toBe("pi_1")
            expect(url.searchParams.get("created[gte]")).toBe("1700000000")
            expect(url.searchParams.get("transfer_group")).toBe("order_1")
          }
        }
      }
    )
  }

  test("rejects empty path ids before requesting Stripe", async () => {
    const calls = recorder([])
    const c = await createTestClient()
    const cases: readonly (readonly [() => unknown, string])[] = [
      [() => c.customers.get(" "), "customer id"],
      [() => c.charges.get(" "), "charge id"],
      [() => c.charges.update(" "), "charge id"],
      [() => c.invoices.listLineItems(" "), "invoice id"],
      [() => c.invoices.listAllLineItems(" "), "invoice id"],
      [() => c.invoices.updateLineItem(" ", "il_1"), "invoice id"],
      [() => c.invoices.updateLineItem("in_1", " "), "invoice line item id"],
      [() => c.invoices.addLines(" ", { lines: [] }), "invoice id"],
      [() => c.invoices.updateLines(" ", { lines: [] }), "invoice id"],
      [() => c.invoices.removeLines(" ", { lines: [] }), "invoice id"],
      [() => c.invoicePayments.get(" "), "invoice payment id"],
      [() => c.paymentIntents.get(" "), "payment intent id"],
      [() => c.paymentIntents.update(" "), "payment intent id"],
      [() => c.paymentIntents.confirm(" "), "payment intent id"],
      [() => c.paymentIntents.capture(" "), "payment intent id"],
      [() => c.paymentIntents.cancel(" "), "payment intent id"],
      [() => c.paymentIntents.incrementAuthorization(" ", { amount: 3000 }), "payment intent id"],
      [() => c.paymentIntents.applyCustomerBalance(" "), "payment intent id"],
      [() => c.paymentIntents.verifyMicrodeposits(" "), "payment intent id"],
      [() => c.paymentIntents.listAmountDetailsLineItems(" "), "payment intent id"],
      [() => c.paymentIntents.listAllAmountDetailsLineItems(" "), "payment intent id"],
    ]

    for (const [run, label] of cases) expect(run).toThrow(`${label} must not be empty`)
    expect(calls).toHaveLength(0)
  })

  test("rejects invalid pagination and event filters before requesting Stripe", async () => {
    const calls = recorder([])
    const c = await createTestClient()
    type Cursor = { limit?: number; starting_after?: string; ending_before?: string }
    const lists: readonly ((params: Cursor) => unknown)[] = [
      (params) => c.customers.list(params),
      (params) => c.charges.list(params),
      (params) => c.charges.listAll(params),
      (params) => c.invoices.listLineItems("in_1", params),
      (params) => c.invoices.listAllLineItems("in_1", params),
      (params) => c.invoicePayments.list(params),
      (params) => c.invoicePayments.listAll(params),
      (params) => c.paymentIntents.list(params),
      (params) => c.paymentIntents.listAll(params),
      (params) => c.paymentIntents.listAmountDetailsLineItems("pi_1", params),
      (params) => c.paymentIntents.listAllAmountDetailsLineItems("pi_1", params),
    ]
    const searches: readonly ((limit: number) => unknown)[] = [
      (limit) => c.charges.search({ query: "amount>100", limit }),
      (limit) => c.charges.searchAll({ query: "amount>100", limit }),
      (limit) => c.paymentIntents.search({ query: "status:'succeeded'", limit }),
      (limit) => c.paymentIntents.searchAll({ query: "status:'succeeded'", limit }),
    ]

    for (const limit of [0, 101, 1.5, Number.NaN]) {
      expect(() => c.charges.list({ limit })).toThrow("between 1 and 100")
    }
    for (const list of lists) {
      expect(() => list({ limit: 101 })).toThrow("between 1 and 100")
      expect(() => list({ starting_after: "a", ending_before: "b" })).toThrow("mutually exclusive")
    }
    for (const search of searches) expect(() => search(101)).toThrow("between 1 and 100")
    expect(() => c.events.list({ type: "invoice.paid", types: ["customer.created"] })).toThrow(
      "type or types"
    )
    expect(() =>
      c.events.list({ types: Array.from({ length: 21 }, () => "invoice.paid") })
    ).toThrow("at most 20")
    expect(calls).toHaveLength(0)
  })
})
