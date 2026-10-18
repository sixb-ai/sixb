import { afterEach, describe, expect, test } from "bun:test"
import { collect, createTestClient, json, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("pennylane customers", () => {
  test("lists and reads customers polymorphically, narrowing on customer_type", async () => {
    const requests: URL[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      requests.push(url)
      if (url.pathname === "/api/external/v2/customers/1") {
        return Promise.resolve(json({ id: 1, customer_type: "company", vat_number: "FR123" }))
      }
      return Promise.resolve(
        json({
          items: [
            { id: 1, customer_type: "company", vat_number: "FR123" },
            { id: 2, customer_type: "individual", first_name: "Ada", last_name: "Lovelace" },
          ],
          has_more: false,
          next_cursor: null,
        })
      )
    })

    const client = await createTestClient()
    const customers = await collect(
      client.customers.listAll({
        filter: [
          { field: "customer_type", operator: "eq", value: "company" },
          { field: "name", operator: "start_with", value: "Acme" },
          { field: "emails", operator: "in", value: ["billing@acme.test"] },
        ],
      })
    )
    const identities = customers.map((customer) =>
      customer.customer_type === "company" ? customer.vat_number : customer.first_name
    )
    expect(identities).toEqual(["FR123", "Ada"])

    const one = await client.customers.get(1)
    expect(one.customer_type).toBe("company")
    expect(requests.map((url) => url.pathname)).toEqual([
      "/api/external/v2/customers",
      "/api/external/v2/customers/1",
    ])
    expect(JSON.parse(requests[0]?.searchParams.get("filter") ?? "")).toHaveLength(3)
  })

  test("routes company and individual writes to typed endpoints", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = []
    mockFetch((input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Promise.resolve(json({ id: 1 }))
    })

    const client = await createTestClient()
    await client.customers.createCompany({
      name: "Acme SAS",
      billing_address: {
        address: "1 rue de Rivoli",
        postal_code: "75001",
        city: "Paris",
        country_alpha2: "FR",
      },
      vat_number: "FR12345678901",
    })
    await client.customers.createIndividual({
      first_name: "Ada",
      last_name: "Lovelace",
      billing_address: {
        address: "2 avenue Foch",
        postal_code: "75116",
        city: "Paris",
        country_alpha2: "FR",
      },
    })
    await client.customers.updateCompany(1, { notes: "Key account" })
    await client.customers.updateIndividual(2, { phone: "+33100000000" })

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/external/v2/company_customers",
      "POST /api/external/v2/individual_customers",
      "PUT /api/external/v2/company_customers/1",
      "PUT /api/external/v2/individual_customers/2",
    ])
    expect(requests[0]?.body).toEqual({
      name: "Acme SAS",
      billing_address: {
        address: "1 rue de Rivoli",
        postal_code: "75001",
        city: "Paris",
        country_alpha2: "FR",
      },
      vat_number: "FR12345678901",
    })
    expect(requests[3]?.body).toEqual({ phone: "+33100000000" })
  })

  test("exposes contacts and category sub-resources", async () => {
    const paths: string[] = []
    let categorizeBody: unknown
    const category = {
      id: 9,
      label: "Consulting",
      weight: "1",
      category_group: { id: 3 },
      analytical_code: null,
      created_at: "2026-07-14T00:00:00Z",
      updated_at: "2026-07-14T00:00:00Z",
    }
    mockFetch((input, init) => {
      const url = new URL(String(input))
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`)
      if (url.pathname.endsWith("/categories") && init?.method === "PUT") {
        categorizeBody = init?.body ? JSON.parse(String(init.body)) : undefined
        return Promise.resolve(json([category]))
      }
      return Promise.resolve(json({ items: [{ id: 1 }], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient()
    await client.customers.listContacts(42, { limit: 10, sort: "-id" })
    await client.customers.listCategories(42)
    const categories = await client.customers.categorize(42, [
      { id: 9, weight: "0.5" },
      { id: 10, weight: "0.5" },
    ])

    expect(paths).toEqual([
      "GET /api/external/v2/customers/42/contacts",
      "GET /api/external/v2/customers/42/categories",
      "PUT /api/external/v2/customers/42/categories",
    ])
    expect(categorizeBody).toEqual([
      { id: 9, weight: "0.5" },
      { id: 10, weight: "0.5" },
    ])
    expect(categories).toEqual([category])
  })
})
