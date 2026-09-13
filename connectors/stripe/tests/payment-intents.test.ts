import { afterEach, describe, expect, test } from "bun:test"
import Stripe from "stripe"
import type {
  PaymentIntentsResource,
  StripePaymentIntent,
  StripePaymentIntentAmountDetailsLineItem,
  StripePaymentIntentCreateParams,
} from "../src"
import { collect, createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("payment intents", () => {
  test("creates a typed payment with nested parameters, Connect context and idempotency", async () => {
    const calls = recorder([
      json({ id: "pi_1", object: "payment_intent", status: "requires_payment_method" }),
    ])
    const client = await createTestClient()
    const params: StripePaymentIntentCreateParams = {
      amount: 2500,
      currency: "eur",
      capture_method: "manual",
      automatic_payment_methods: { enabled: true },
      metadata: { order: "order_1" },
    }
    const payment: StripePaymentIntent = await client.paymentIntents.create(params, {
      idempotencyKey: "order_1:payment",
      stripeAccount: "acct_1",
    })
    expect(payment.id).toBe("pi_1")
    expect(payment.status).toBe("requires_payment_method")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/payment_intents")
    expect(calls[0]?.headers.get("idempotency-key")).toBe("order_1:payment")
    expect(calls[0]?.headers.get("stripe-account")).toBe("acct_1")
    const body = new URLSearchParams(calls[0]?.body)
    expect(body.get("amount")).toBe("2500")
    expect(body.get("currency")).toBe("eur")
    expect(body.get("capture_method")).toBe("manual")
    expect(body.get("automatic_payment_methods[enabled]")).toBe("true")
    expect(body.get("metadata[order]")).toBe("order_1")
  })

  const actions: {
    name: string
    path: string
    key: string
    value: string
    run: (r: PaymentIntentsResource) => Promise<unknown>
  }[] = [
    {
      name: "update",
      path: "",
      key: "metadata[order]",
      value: "order_2",
      run: (r) =>
        r.update(
          "pi_1",
          { metadata: { order: "order_2" } },
          { idempotencyKey: "operation", stripeAccount: "acct_1" }
        ),
    },
    {
      name: "confirm",
      path: "/confirm",
      key: "payment_method",
      value: "pm_1",
      run: (r) =>
        r.confirm(
          "pi_1",
          { payment_method: "pm_1" },
          { idempotencyKey: "operation", stripeAccount: "acct_1" }
        ),
    },
    {
      name: "capture",
      path: "/capture",
      key: "amount_to_capture",
      value: "1500",
      run: (r) =>
        r.capture(
          "pi_1",
          { amount_to_capture: 1500 },
          { idempotencyKey: "operation", stripeAccount: "acct_1" }
        ),
    },
    {
      name: "cancel",
      path: "/cancel",
      key: "cancellation_reason",
      value: "requested_by_customer",
      run: (r) =>
        r.cancel(
          "pi_1",
          { cancellation_reason: "requested_by_customer" },
          { idempotencyKey: "operation", stripeAccount: "acct_1" }
        ),
    },
    {
      name: "incrementAuthorization",
      path: "/increment_authorization",
      key: "amount",
      value: "3000",
      run: (r) =>
        r.incrementAuthorization(
          "pi_1",
          { amount: 3000 },
          { idempotencyKey: "operation", stripeAccount: "acct_1" }
        ),
    },
    {
      name: "applyCustomerBalance",
      path: "/apply_customer_balance",
      key: "amount",
      value: "500",
      run: (r) =>
        r.applyCustomerBalance(
          "pi_1",
          { amount: 500 },
          { idempotencyKey: "operation", stripeAccount: "acct_1" }
        ),
    },
    {
      name: "verifyMicrodeposits",
      path: "/verify_microdeposits",
      key: "descriptor_code",
      value: "SM1234",
      run: (r) =>
        r.verifyMicrodeposits(
          "pi_1",
          { descriptor_code: "SM1234" },
          { idempotencyKey: "operation", stripeAccount: "acct_1" }
        ),
    },
  ]
  for (const action of actions) {
    test(`${action.name} forwards the body and request options to its documented endpoint`, async () => {
      const calls = recorder([json({ id: "pi_1", object: "payment_intent" })])
      const client = await createTestClient()
      await action.run(client.paymentIntents)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.method).toBe("POST")
      expect(calls[0]?.url).toBe(`https://api.stripe.com/v1/payment_intents/pi_1${action.path}`)
      expect(new URLSearchParams(calls[0]?.body).get(action.key)).toBe(action.value)
      expect(calls[0]?.headers.get("idempotency-key")).toBe("operation")
      expect(calls[0]?.headers.get("stripe-account")).toBe("acct_1")
    })
  }

  test("get preserves expansion, response metadata and requires_action without confirming again", async () => {
    const nextAction = {
      type: "redirect_to_url",
      redirect_to_url: { url: "https://example.com/auth", return_url: null },
    }
    const calls = recorder([
      json({
        id: "pi_1",
        object: "payment_intent",
        status: "requires_action",
        next_action: nextAction,
      }),
    ])
    const client = await createTestClient()
    const payment = await client.paymentIntents.get(
      "pi_1",
      { expand: ["latest_charge"] },
      { stripeAccount: "acct_1" }
    )
    expect(payment.status).toBe("requires_action")
    expect(payment.next_action).toEqual(nextAction)
    expect(payment.lastResponse.requestId).toBe("req_test")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("GET")
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/payment_intents/pi_1")
    expect(new URL(calls[0]!.url).searchParams.get("expand[0]")).toBe("latest_charge")
    expect(calls[0]?.headers.get("stripe-account")).toBe("acct_1")
  })

  for (const mode of ["list", "search", "lineItems"] as const) {
    test(`${mode} supports pages and follows the provider cursor with filters and account intact`, async () => {
      const search = mode === "search"
      const path =
        mode === "lineItems"
          ? "/v1/payment_intents/pi_1/amount_details_line_items"
          : `/v1/payment_intents${search ? "/search" : ""}`
      const calls = recorder((request) => {
        const query = new URL(request.url).searchParams
        const second = query.has(search ? "page" : "starting_after")
        return json({
          object: search ? "search_result" : "list",
          url: path,
          data: [{ id: second ? "item_2" : "item_1" }],
          has_more: !second,
          ...(search ? { next_page: second ? null : "next_token" } : {}),
        })
      })
      const client = await createTestClient()
      const r = client.paymentIntents
      const options = { stripeAccount: "acct_1" }
      const params = { customer: "cus_1", limit: 1 }
      const searchParams = { query: "metadata['order']:'order_1'", limit: 1 }
      const page = await (mode === "list"
        ? r.list(params, options)
        : search
          ? r.search(searchParams, options)
          : r.listAmountDetailsLineItems("pi_1", { limit: 1 }, options))
      expect(page.data.map((item) => item.id)).toEqual(["item_1"])
      const items = await collect<StripePaymentIntent | StripePaymentIntentAmountDetailsLineItem>(
        mode === "list"
          ? r.listAll(params, options)
          : search
            ? r.searchAll(searchParams, options)
            : r.listAllAmountDetailsLineItems("pi_1", { limit: 1 }, options)
      )
      expect(items.map((item) => item.id)).toEqual(["item_1", "item_2"])
      expect(calls).toHaveLength(3)
      expect(new URL(calls[2]!.url).searchParams.get(search ? "page" : "starting_after")).toBe(
        search ? "next_token" : "item_1"
      )
      for (const call of calls) {
        expect(call.method).toBe("GET")
        expect(new URL(call.url).pathname).toBe(path)
        expect(new URL(call.url).searchParams.get("limit")).toBe("1")
        expect(call.headers.get("stripe-account")).toBe("acct_1")
        if (mode === "list") expect(new URL(call.url).searchParams.get("customer")).toBe("cus_1")
        if (search) expect(new URL(call.url).searchParams.get("query")).toBe(searchParams.query)
      }
    })
  }

  test("rejects invalid ids and pagination before network access", async () => {
    const calls = recorder([])
    const { paymentIntents: r } = await createTestClient()
    const idCalls = [
      () => r.get(" "),
      () => r.update(" "),
      () => r.confirm(" "),
      () => r.capture(" "),
      () => r.cancel(" "),
      () => r.incrementAuthorization(" ", { amount: 3000 }),
      () => r.applyCustomerBalance(" "),
      () => r.verifyMicrodeposits(" "),
      () => r.listAmountDetailsLineItems(" "),
      () => r.listAllAmountDetailsLineItems(" "),
    ]
    for (const run of idCalls) expect(run).toThrow("payment intent id must not be empty")
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      expect(() => r.list({ limit })).toThrow("between 1 and 100")
      expect(() => r.listAll({ limit })).toThrow("between 1 and 100")
      expect(() => r.search({ query: "status:'succeeded'", limit })).toThrow("between 1 and 100")
      expect(() => r.searchAll({ query: "status:'succeeded'", limit })).toThrow("between 1 and 100")
      expect(() => r.listAmountDetailsLineItems("pi_1", { limit })).toThrow("between 1 and 100")
      expect(() => r.listAllAmountDetailsLineItems("pi_1", { limit })).toThrow("between 1 and 100")
    }
    const cursors = { starting_after: "pi_1", ending_before: "pi_2" }
    expect(() => r.list(cursors)).toThrow("mutually exclusive")
    expect(() => r.listAll(cursors)).toThrow("mutually exclusive")
    expect(() => r.listAmountDetailsLineItems("pi_1", cursors)).toThrow("mutually exclusive")
    expect(() => r.listAllAmountDetailsLineItems("pi_1", cursors)).toThrow("mutually exclusive")
    expect(calls).toHaveLength(0)
  })

  test("preserves card declines and the PaymentIntent on the Stripe error", async () => {
    recorder([
      json(
        {
          error: {
            type: "card_error",
            code: "card_declined",
            decline_code: "insufficient_funds",
            message: "Your card has insufficient funds.",
            payment_intent: { id: "pi_1", status: "requires_payment_method" },
          },
        },
        { status: 402 }
      ),
    ])
    const client = await createTestClient()
    const error: unknown = await client.paymentIntents.confirm("pi_1").catch((error) => error)
    expect(error).toBeInstanceOf(Stripe.errors.StripeCardError)
    if (!(error instanceof Stripe.errors.StripeCardError)) throw error
    expect(error.code).toBe("card_declined")
    expect(error.decline_code).toBe("insufficient_funds")
    expect(error.requestId).toBe("req_test")
    expect(error.payment_intent?.id).toBe("pi_1")
  })
})
