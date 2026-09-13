import { afterEach, describe, expect, test } from "bun:test"
import type { ChargesResource, StripeCharge, StripeChargeUpdateParams } from "../src"
import { collect, createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("charges", () => {
  test("exposes only the six supported methods", async () => {
    const client = await createTestClient()
    const charges: ChargesResource = client.charges
    expect(Object.keys(charges).sort()).toEqual([
      "get",
      "list",
      "listAll",
      "search",
      "searchAll",
      "update",
    ])
  })

  test("get preserves expanded relations, nullable PaymentIntent and response metadata", async () => {
    const calls = recorder([
      json({
        id: "ch_1",
        object: "charge",
        payment_intent: null,
        balance_transaction: { id: "txn_1", object: "balance_transaction", fee: 100, net: 2400 },
      }),
    ])
    const client = await createTestClient()
    const charge = await client.charges.get(
      "ch_1",
      { expand: ["balance_transaction"] },
      { stripeAccount: "acct_1" }
    )
    const typedCharge: StripeCharge = charge
    expect(typedCharge.payment_intent).toBeNull()
    const transaction = typedCharge.balance_transaction
    if (!transaction || typeof transaction === "string")
      throw new Error("Expected expanded transaction")
    expect(transaction.fee).toBe(100)
    expect(transaction.net).toBe(2400)
    expect(charge.lastResponse.requestId).toBe("req_test")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("GET")
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe("/v1/charges/ch_1")
    expect(url.searchParams.get("expand[0]")).toBe("balance_transaction")
    expect(calls[0]?.headers.get("stripe-account")).toBe("acct_1")
  })

  test("update forwards form parameters and idempotency without additional requests", async () => {
    const calls = recorder([json({ id: "ch_1", object: "charge" })])
    const client = await createTestClient()
    const params: StripeChargeUpdateParams = {
      description: "Order 123",
      metadata: { order: "123" },
      receipt_email: "customer@example.com",
    }
    await client.charges.update("ch_1", params, {
      idempotencyKey: "charge:123:update",
      stripeAccount: "acct_1",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/charges/ch_1")
    const body = new URLSearchParams(calls[0]?.body)
    expect(body.get("description")).toBe("Order 123")
    expect(body.get("metadata[order]")).toBe("123")
    expect(body.get("receipt_email")).toBe("customer@example.com")
    expect(calls[0]?.headers.get("idempotency-key")).toBe("charge:123:update")
    expect(calls[0]?.headers.get("stripe-account")).toBe("acct_1")
  })

  for (const search of [false, true]) {
    test(
      search
        ? "search pages and searchAll retain the query and account"
        : "list pages and listAll retain all filters and account",
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
        const options = { stripeAccount: "acct_1" }
        const page = await (search
          ? client.charges.search(searchParams, options)
          : client.charges.list(params, options))
        expect(page.data.map((item) => item.id)).toEqual(["ch_1"])
        const items = await collect(
          search
            ? client.charges.searchAll(searchParams, options)
            : client.charges.listAll(params, options)
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

  test("rejects invalid ids, limits and conflicting cursors before requesting Stripe", async () => {
    const calls = recorder([])
    const { charges } = await createTestClient()
    expect(() => charges.get(" ")).toThrow("charge id must not be empty")
    expect(() => charges.update(" ")).toThrow("charge id must not be empty")
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      expect(() => charges.list({ limit })).toThrow("between 1 and 100")
      expect(() => charges.listAll({ limit })).toThrow("between 1 and 100")
      expect(() => charges.search({ query: "amount>100", limit })).toThrow("between 1 and 100")
      expect(() => charges.searchAll({ query: "amount>100", limit })).toThrow("between 1 and 100")
    }
    const cursors = { starting_after: "ch_1", ending_before: "ch_2" }
    expect(() => charges.list(cursors)).toThrow("mutually exclusive")
    expect(() => charges.listAll(cursors)).toThrow("mutually exclusive")
    expect(calls).toHaveLength(0)
  })
})
