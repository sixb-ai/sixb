import { afterEach, describe, expect, test } from "bun:test"
import { collect, createTestClient, json, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("pennylane products", () => {
  test("sends documented product list, read, and write requests", async () => {
    const requests: Array<{
      method: string
      path: string
      query: Record<string, string>
      body: unknown
    }> = []
    mockFetch((input, init) => {
      const url = new URL(String(input))
      requests.push({
        method: init?.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Promise.resolve(
        json(
          url.pathname.endsWith("/products")
            ? { items: [{ id: 7 }], has_more: false, next_cursor: null }
            : { id: 7 }
        )
      )
    })

    const client = await createTestClient()
    const filter = [
      { field: "label", operator: "in", value: ["Consulting", "Support"] },
      { field: "external_reference", operator: "eq", value: "SKU-1" },
    ] as const
    const products = await collect(client.products.listAll({ limit: 50, sort: "-id", filter }))
    expect(products.map((product) => product.id)).toEqual([7])
    await client.products.get(7)
    await client.products.create({
      label: "Consulting",
      price_before_tax: "1000.00",
      vat_rate: "FR_200",
      unit: "day",
      ledger_account_id: 12,
    })
    await client.products.update(7, { price_before_tax: "1200.00" })

    expect(requests).toEqual([
      {
        method: "GET",
        path: "/api/external/v2/products",
        query: { limit: "50", sort: "-id", filter: JSON.stringify(filter) },
        body: undefined,
      },
      { method: "GET", path: "/api/external/v2/products/7", query: {}, body: undefined },
      {
        method: "POST",
        path: "/api/external/v2/products",
        query: {},
        body: {
          label: "Consulting",
          price_before_tax: "1000.00",
          vat_rate: "FR_200",
          unit: "day",
          ledger_account_id: 12,
        },
      },
      {
        method: "PUT",
        path: "/api/external/v2/products/7",
        query: {},
        body: { price_before_tax: "1200.00" },
      },
    ])
  })

  test("validates identifiers and limits before fetch", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(json({ items: [], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient()
    expect(() => client.products.get(0)).toThrow("positive safe integer")
    expect(() => client.products.list({ limit: 101 })).toThrow("between 1 and 100")
    expect(calls).toBe(0)
  })
})
