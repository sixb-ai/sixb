import { afterEach, describe, expect, test } from "bun:test"
import { collect, createTestClient, json, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("pennylane products", () => {
  test("lists products with bearer auth and typed filters", async () => {
    let requestUrl = ""
    let requestHeaders = new Headers()
    mockFetch((input, init) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      return Promise.resolve(json({ items: [], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient()
    await client.products.list({
      limit: 50,
      sort: "-id",
      filter: [
        { field: "label", operator: "in", value: ["Consulting", "Support"] },
        { field: "external_reference", operator: "eq", value: "SKU-1" },
      ],
    })

    const url = new URL(requestUrl)
    expect(url.pathname).toBe("/api/external/v2/products")
    expect(url.searchParams.get("limit")).toBe("50")
    expect(url.searchParams.get("sort")).toBe("-id")
    expect(JSON.parse(url.searchParams.get("filter") ?? "")).toEqual([
      { field: "label", operator: "in", value: ["Consulting", "Support"] },
      { field: "external_reference", operator: "eq", value: "SKU-1" },
    ])
    expect(requestHeaders.get("authorization")).toBe("Bearer pl-token")
  })

  test("listAll follows opaque cursors", async () => {
    const cursors: (string | null)[] = []
    mockFetch((input) => {
      const cursor = new URL(String(input)).searchParams.get("cursor")
      cursors.push(cursor)
      return Promise.resolve(
        json(
          cursor === null
            ? { items: [{ id: 1 }], has_more: true, next_cursor: "next" }
            : { items: [{ id: 2 }], has_more: false, next_cursor: null }
        )
      )
    })

    const client = await createTestClient()
    const products = await collect(client.products.listAll({ limit: 1 }))

    expect(products.map((product) => product.id)).toEqual([1, 2])
    expect(cursors).toEqual([null, "next"])
  })

  test("sends documented product write payloads and paths", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = []
    mockFetch((input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Promise.resolve(json({ id: 7 }))
    })

    const client = await createTestClient()
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
      { path: "/api/external/v2/products/7", method: "GET", body: undefined },
      {
        path: "/api/external/v2/products",
        method: "POST",
        body: {
          label: "Consulting",
          price_before_tax: "1000.00",
          vat_rate: "FR_200",
          unit: "day",
          ledger_account_id: 12,
        },
      },
      {
        path: "/api/external/v2/products/7",
        method: "PUT",
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
