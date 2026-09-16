import { afterEach, describe, expect, test } from "bun:test"
import Stripe from "stripe"
import type {
  StripeInvoice,
  StripeInvoiceLineItem,
  StripeInvoicePayment,
  StripeInvoicePaymentListParams,
} from "../src"
import { collect, createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const options = { stripeAccount: "acct_1", idempotencyKey: "invoice:operation" }

describe("invoice lines", () => {
  test("updates a line with both ids encoded, nested parameters and response metadata", async () => {
    const calls = recorder([json({ id: "il_1", object: "line_item", amount: -500 })])
    const client = await createTestClient()
    const response = await client.invoices.updateLineItem(
      "in/1",
      "il/1",
      { amount: -500, metadata: { order: "123" }, discounts: "" },
      options
    )
    const line: StripeInvoiceLineItem = response
    expect(line.amount).toBe(-500)
    expect(response.lastResponse.requestId).toBe("req_test")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/invoices/in%2F1/lines/il%2F1")
    expect(calls[0]?.method).toBe("POST")
    const body = new URLSearchParams(calls[0]?.body)
    expect(body.get("amount")).toBe("-500")
    expect(body.get("metadata[order]")).toBe("123")
    expect(body.get("discounts")).toBe("")
    expect(calls[0]?.headers.get("stripe-account")).toBe("acct_1")
    expect(calls[0]?.headers.get("idempotency-key")).toBe("invoice:operation")
  })

  for (const operation of ["addLines", "updateLines", "removeLines"] as const) {
    test(`${operation} sends one bulk request and returns the updated invoice`, async () => {
      const calls = recorder([json({ id: "in_1", object: "invoice", status: "draft" })])
      const client = await createTestClient()
      const response =
        operation === "addLines"
          ? await client.invoices.addLines(
              "in_1",
              {
                lines: [{ amount: -500, description: "Credit" }, { invoice_item: "ii_1" }],
                invoice_metadata: { order: "123" },
              },
              options
            )
          : operation === "updateLines"
            ? await client.invoices.updateLines(
                "in_1",
                {
                  lines: [
                    { id: "il_1", amount: 700 },
                    { id: "il_2", description: "Revised" },
                  ],
                  invoice_metadata: { order: "123" },
                },
                options
              )
            : await client.invoices.removeLines(
                "in_1",
                {
                  lines: [
                    { id: "il_1", behavior: "unassign" },
                    { id: "il_2", behavior: "delete" },
                  ],
                  invoice_metadata: { order: "123" },
                },
                options
              )
      const invoice: StripeInvoice = response
      expect(invoice.object).toBe("invoice")
      expect(response.lastResponse.requestId).toBe("req_test")
      expect(calls).toHaveLength(1)
      const endpoint = {
        addLines: "add_lines",
        updateLines: "update_lines",
        removeLines: "remove_lines",
      }[operation]
      expect(calls[0]?.url).toBe(`https://api.stripe.com/v1/invoices/in_1/${endpoint}`)
      expect(calls[0]?.method).toBe("POST")
      expect(calls[0]?.headers.get("stripe-account")).toBe("acct_1")
      expect(calls[0]?.headers.get("idempotency-key")).toBe("invoice:operation")
      const body = new URLSearchParams(calls[0]?.body)
      expect(body.get("invoice_metadata[order]")).toBe("123")
      if (operation === "addLines") {
        expect(body.get("lines[0][amount]")).toBe("-500")
        expect(body.get("lines[1][invoice_item]")).toBe("ii_1")
      } else {
        expect(body.get("lines[0][id]")).toBe("il_1")
        expect(body.get("lines[1][id]")).toBe("il_2")
        if (operation === "updateLines") {
          expect(body.get("lines[0][amount]")).toBe("700")
          expect(body.get("lines[1][description]")).toBe("Revised")
        } else {
          expect(body.get("lines[0][behavior]")).toBe("unassign")
          expect(body.get("lines[1][behavior]")).toBe("delete")
        }
      }
    })
  }

  test("preserves Stripe's rejection of a finalized invoice without retrying or splitting the batch", async () => {
    const calls = recorder([
      json(
        {
          error: {
            type: "invalid_request_error",
            message: "Invoice is finalized",
            param: "invoice",
          },
        },
        { status: 400 }
      ),
    ])
    const client = await createTestClient()
    const error: unknown = await client.invoices
      .addLines("in_1", { lines: [{ amount: 500 }] })
      .catch((error) => error)
    expect(error).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError)
    if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error
    expect(error.statusCode).toBe(400)
    expect(error.param).toBe("invoice")
    expect(error.requestId).toBe("req_test")
    expect(calls).toHaveLength(1)
  })
})

describe("invoice payments", () => {
  for (const type of ["payment_intent", "charge", "payment_record"] as const) {
    test(`get preserves ${type} allocation and nullable amount_paid`, async () => {
      const payment = {
        type,
        [type]: type === "payment_intent" ? { id: "pi_1", object: "payment_intent" } : "payment_1",
      }
      const calls = recorder([
        json({
          id: "inpay_1",
          object: "invoice_payment",
          invoice: "in_1",
          amount_paid: null,
          status: "open",
          payment,
        }),
      ])
      const client = await createTestClient()
      const response = await client.invoicePayments.get(
        "inpay/1",
        { expand: ["payment.payment_intent"] },
        options
      )
      const allocation: StripeInvoicePayment = response
      expect(allocation.amount_paid).toBeNull()
      expect(allocation.payment).toEqual(payment)
      expect(response.lastResponse.requestId).toBe("req_test")
      expect(calls).toHaveLength(1)
      const url = new URL(calls[0]!.url)
      expect(calls[0]?.method).toBe("GET")
      expect(url.pathname).toBe("/v1/invoice_payments/inpay%2F1")
      expect(url.searchParams.get("expand[0]")).toBe("payment.payment_intent")
      expect(calls[0]?.headers.get("stripe-account")).toBe("acct_1")
    })
  }
})

describe("invoice collection pagination", () => {
  for (const resource of ["lines", "payments"] as const) {
    test(`${resource} pages and iterators preserve scope, expansion and Connect options`, async () => {
      const path = resource === "lines" ? "/v1/invoices/in_1/lines" : "/v1/invoice_payments"
      const calls = recorder((request) => {
        const second = new URL(request.url).searchParams.has("starting_after")
        return json({
          object: "list",
          url: path,
          has_more: !second,
          data: [{ id: second ? "item_2" : "item_1" }],
        })
      })
      const client = await createTestClient()
      const params: StripeInvoicePaymentListParams = {
        invoice: "in_1",
        status: "paid",
        created: { gte: 1700000000 },
        payment: { type: "payment_intent", payment_intent: "pi_1" },
        limit: 1,
        expand: ["data.payment.payment_intent"],
      }
      const lineParams = { limit: 1, expand: ["data.discounts"] }
      const page = await (resource === "lines"
        ? client.invoices.listLineItems("in_1", lineParams, options)
        : client.invoicePayments.list(params, options))
      expect(page.data.map((item) => item.id)).toEqual(["item_1"])
      const items = await collect<StripeInvoiceLineItem | StripeInvoicePayment>(
        resource === "lines"
          ? client.invoices.listAllLineItems("in_1", lineParams, options)
          : client.invoicePayments.listAll(params, options)
      )
      expect(items.map((item) => item.id)).toEqual(["item_1", "item_2"])
      expect(calls).toHaveLength(3)
      expect(new URL(calls[2]!.url).searchParams.get("starting_after")).toBe("item_1")
      for (const call of calls) {
        const url = new URL(call.url)
        expect(call.method).toBe("GET")
        expect(url.pathname).toBe(path)
        expect(call.headers.get("stripe-account")).toBe("acct_1")
        expect(url.searchParams.get("limit")).toBe("1")
        expect(url.searchParams.get("expand[0]")).toBe(
          resource === "lines" ? "data.discounts" : "data.payment.payment_intent"
        )
        if (resource === "payments") {
          expect(url.searchParams.get("invoice")).toBe("in_1")
          expect(url.searchParams.get("status")).toBe("paid")
          expect(url.searchParams.get("created[gte]")).toBe("1700000000")
          expect(url.searchParams.get("payment[type]")).toBe("payment_intent")
          expect(url.searchParams.get("payment[payment_intent]")).toBe("pi_1")
        }
      }
    })

    test(`${resource} stops at an empty page and propagates a later-page failure`, async () => {
      const path = resource === "lines" ? "/v1/invoices/in_1/lines" : "/v1/invoice_payments"
      const calls = recorder([
        json({ object: "list", url: path, data: [], has_more: false }),
        json({ object: "list", url: path, data: [{ id: "item_1" }], has_more: true }),
        json({ error: { type: "api_error", message: "Unavailable" } }, { status: 500 }),
      ])
      const client = await createTestClient()
      const iterate = () =>
        resource === "lines"
          ? client.invoices.listAllLineItems("in_1")
          : client.invoicePayments.listAll()
      expect(await collect<StripeInvoiceLineItem | StripeInvoicePayment>(iterate())).toEqual([])
      await expect(
        collect<StripeInvoiceLineItem | StripeInvoicePayment>(iterate())
      ).rejects.toThrow("Unavailable")
      expect(calls).toHaveLength(3)
    })
  }

  test("rejects empty path ids and invalid pagination before network access", async () => {
    const calls = recorder([])
    const client = await createTestClient()
    const r = client.invoices
    for (const run of [
      () => r.listLineItems(" "),
      () => r.listAllLineItems(" "),
      () => r.updateLineItem(" ", "il_1"),
      () => r.updateLineItem("in_1", " "),
      () => r.addLines(" ", { lines: [] }),
      () => r.updateLines(" ", { lines: [] }),
      () => r.removeLines(" ", { lines: [] }),
      () => client.invoicePayments.get(" "),
    ])
      expect(run).toThrow("must not be empty")
    const requests = [
      (params: { limit?: number; starting_after?: string; ending_before?: string }) =>
        r.listLineItems("in_1", params),
      (params: { limit?: number; starting_after?: string; ending_before?: string }) =>
        r.listAllLineItems("in_1", params),
      (params: { limit?: number; starting_after?: string; ending_before?: string }) =>
        client.invoicePayments.list(params),
      (params: { limit?: number; starting_after?: string; ending_before?: string }) =>
        client.invoicePayments.listAll(params),
    ]
    for (const request of requests) {
      for (const limit of [0, 101, 1.5, Number.NaN])
        expect(() => request({ limit })).toThrow("between 1 and 100")
      expect(() => request({ starting_after: "a", ending_before: "b" })).toThrow(
        "mutually exclusive"
      )
    }
    expect(calls).toHaveLength(0)
  })
})
