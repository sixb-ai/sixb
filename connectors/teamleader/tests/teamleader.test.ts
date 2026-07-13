import { describe, expect, test } from "bun:test"
import { noopLogger } from "@sixb/core"
import {
  customFieldsByDefinitionId,
  customFieldsByLabel,
  defineTeamleaderWebhook,
  TeamleaderApiError,
  teamleader,
} from "../src"
import { createTeamleaderClient } from "../src/client"
import type { TeamleaderCustomField, TeamleaderCustomFieldDefinition } from "../src/types"

type CapturedRequest = {
  readonly input: RequestInfo | URL
  readonly init: RequestInit | undefined
}

function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof fetch {
  return implementation as typeof fetch
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("teamleader connector", () => {
  test("creates a Teamleader adapter", async () => {
    const adapter = teamleader({
      accessToken: "test-token",
      fetch: mockFetch(() => Promise.resolve(jsonResponse({ data: [] }))),
    })

    const client = await adapter.connect({
      projectId: "demo",
      connectorId: "teamleader",
      signal: new AbortController().signal,
    })

    const response = await client.deals.list()

    expect(adapter.type).toBe("teamleader")
    expect(response.data).toEqual([])
  })

  test("sends JSON POST requests with a bearer token", async () => {
    const requests: CapturedRequest[] = []
    const client = createTeamleaderClient({
      accessToken: () => "resolved-token",
      fetch: mockFetch((input, init) => {
        requests.push({ input, init })
        return Promise.resolve(jsonResponse({ data: [{ id: "deal-1" }] }))
      }),
    })

    const response = await client.deals.list({
      filter: { ids: ["deal-1"] },
      includes: "custom_fields",
    })

    const [request] = requests
    const headers = new Headers(request.init?.headers)

    expect(String(request.input)).toBe("https://api.focus.teamleader.eu/deals.list")
    expect(request.init?.method).toBe("POST")
    expect(headers.get("authorization")).toBe("Bearer resolved-token")
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(String(request.init?.body))).toEqual({
      filter: { ids: ["deal-1"] },
      includes: "custom_fields",
    })
    expect(response.data).toEqual([{ id: "deal-1" }])
  })

  test("supports documented deal actions", async () => {
    const requests: CapturedRequest[] = []
    const client = createTeamleaderClient({
      accessToken: "test-token",
      fetch: mockFetch((input, init) => {
        requests.push({ input, init })
        const path = new URL(String(input)).pathname

        if (path === "/deals.create") {
          return Promise.resolve(
            jsonResponse({ data: { type: "deal", id: "deal-1" } }, { status: 201 })
          )
        }

        return Promise.resolve(new Response(undefined, { status: 204 }))
      }),
    })

    const created = await client.deals.create({
      lead: {
        customer: { type: "company", id: "company-1" },
        contact_person_id: "contact-1",
      },
      title: "Interesting business deal",
      summary: "Additional information",
      source_id: "source-1",
      department_id: "department-1",
      responsible_user_id: "user-1",
      phase_id: "phase-1",
      estimated_value: { amount: 123.3, currency: "EUR" },
      estimated_probability: 0.75,
      estimated_closing_date: "2017-05-09",
      custom_fields: [{ id: "field-1", value: "BeHome" }],
      currency: { code: "EUR", exchange_rate: 1 },
      purchase_order_number: "000023",
    })
    await client.deals.update({
      id: "deal-1",
      title: "Updated deal",
      summary: null,
      source_id: null,
      department_id: null,
      responsible_user_id: null,
      estimated_value: null,
      estimated_probability: null,
      estimated_closing_date: null,
      custom_fields: [{ id: "field-1", value: ["BeHome", "Placard"] }],
      currency: { code: "EUR", exchange_rate: 1 },
      purchase_order_number: null,
    })
    await client.deals.move({ id: "deal-1", phase_id: "phase-2" })
    await client.deals.win({ id: "deal-1" })
    await client.deals.lose({
      id: "deal-1",
      reason_id: "lost-reason-1",
      extra_info: "Decision postponed",
    })
    await client.deals.delete({ id: "deal-1" })

    expect(created.data).toEqual({ type: "deal", id: "deal-1" })
    expect(requests.map((request) => new URL(String(request.input)).pathname)).toEqual([
      "/deals.create",
      "/deals.update",
      "/deals.move",
      "/deals.win",
      "/deals.lose",
      "/deals.delete",
    ])
    expect(requests.map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      {
        lead: {
          customer: { type: "company", id: "company-1" },
          contact_person_id: "contact-1",
        },
        title: "Interesting business deal",
        summary: "Additional information",
        source_id: "source-1",
        department_id: "department-1",
        responsible_user_id: "user-1",
        phase_id: "phase-1",
        estimated_value: { amount: 123.3, currency: "EUR" },
        estimated_probability: 0.75,
        estimated_closing_date: "2017-05-09",
        custom_fields: [{ id: "field-1", value: "BeHome" }],
        currency: { code: "EUR", exchange_rate: 1 },
        purchase_order_number: "000023",
      },
      {
        id: "deal-1",
        title: "Updated deal",
        summary: null,
        source_id: null,
        department_id: null,
        responsible_user_id: null,
        estimated_value: null,
        estimated_probability: null,
        estimated_closing_date: null,
        custom_fields: [{ id: "field-1", value: ["BeHome", "Placard"] }],
        currency: { code: "EUR", exchange_rate: 1 },
        purchase_order_number: null,
      },
      { id: "deal-1", phase_id: "phase-2" },
      { id: "deal-1" },
      { id: "deal-1", reason_id: "lost-reason-1", extra_info: "Decision postponed" },
      { id: "deal-1" },
    ])
  })

  test("supports documented quotation actions", async () => {
    const requests: CapturedRequest[] = []
    const client = createTeamleaderClient({
      accessToken: "test-token",
      fetch: mockFetch((input, init) => {
        requests.push({ input, init })
        const path = new URL(String(input)).pathname

        if (path === "/quotations.create") {
          return Promise.resolve(jsonResponse({ data: { type: "quotation", id: "quotation-1" } }))
        }

        if (path === "/quotations.download") {
          return Promise.resolve(
            jsonResponse({
              data: {
                location: "https://cdn.teamleader.eu/file",
                expires: "2018-02-05T16:44:33+00:00",
              },
            })
          )
        }

        return Promise.resolve(new Response(undefined, { status: 204 }))
      }),
    })

    const created = await client.quotations.create({
      deal_id: "deal-1",
      text: "Quotation text",
    })
    const download = await client.quotations.download({ id: "quotation-1", format: "pdf" })
    await client.quotations.send({
      quotations: ["quotation-1"],
      recipients: { to: [{ email_address: "quentin@sixb.ai" }] },
      subject: "Quotation",
      content: "Sign your offer here #LINK",
      language: "fr",
    })
    await client.quotations.update({ id: "quotation-1", text: "Updated text" })
    await client.quotations.accept({ id: "quotation-1" })
    await client.quotations.delete({ id: "quotation-1" })

    expect(created.data).toEqual({ type: "quotation", id: "quotation-1" })
    expect(download.data.location).toBe("https://cdn.teamleader.eu/file")
    expect(requests.map((request) => new URL(String(request.input)).pathname)).toEqual([
      "/quotations.create",
      "/quotations.download",
      "/quotations.send",
      "/quotations.update",
      "/quotations.accept",
      "/quotations.delete",
    ])
    expect(requests.map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      { deal_id: "deal-1", text: "Quotation text" },
      { id: "quotation-1", format: "pdf" },
      {
        quotations: ["quotation-1"],
        recipients: { to: [{ email_address: "quentin@sixb.ai" }] },
        subject: "Quotation",
        content: "Sign your offer here #LINK",
        language: "fr",
      },
      { id: "quotation-1", text: "Updated text" },
      { id: "quotation-1" },
      { id: "quotation-1" },
    ])
  })

  test("supports documented product actions", async () => {
    const requests: CapturedRequest[] = []
    const client = createTeamleaderClient({
      accessToken: "test-token",
      fetch: mockFetch((input, init) => {
        requests.push({ input, init })
        const path = new URL(String(input)).pathname

        if (path === "/products.add") {
          return Promise.resolve(jsonResponse({ data: { type: "product", id: "product-1" } }))
        }

        return Promise.resolve(new Response(undefined, { status: 204 }))
      }),
    })

    const added = await client.products.add({
      name: "Hosting",
      code: "HOST-001",
      description: "Product used for hosting web solutions",
      purchase_price: { amount: 50, currency: "EUR" },
      selling_price: { amount: 100, currency: "EUR" },
      unit_of_measure_id: "unit-1",
      price_list_prices: [
        { price_list_id: "price-list-1", price: { amount: 90, currency: "EUR" } },
      ],
      stock: { amount: 12 },
      configuration: { stock_threshold: { minimum: 4, action: "notify" } },
      department_id: "department-1",
      product_category_id: "category-1",
      tax_rate_id: "tax-rate-1",
      custom_fields: [{ id: "field-1", value: "external-reference" }],
    })
    await client.products.update({
      id: "product-1",
      name: "Updated hosting",
      code: null,
      description: null,
      purchase_price: null,
      selling_price: { amount: 120, currency: "EUR" },
      unit_of_measure_id: null,
      price_list_prices: [
        { price_list_id: "price-list-1", price: { amount: 110, currency: "EUR" } },
      ],
      stock: { amount: 10 },
      configuration: null,
      department_id: "department-1",
      product_category_id: "category-1",
      tax_rate_id: "tax-rate-1",
      custom_fields: [{ id: "field-1", value: "updated-reference" }],
    })
    await client.products.delete({ id: "product-1" })

    expect(added.data).toEqual({ type: "product", id: "product-1" })
    expect(requests.map((request) => new URL(String(request.input)).pathname)).toEqual([
      "/products.add",
      "/products.update",
      "/products.delete",
    ])
    expect(requests.map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      {
        name: "Hosting",
        code: "HOST-001",
        description: "Product used for hosting web solutions",
        purchase_price: { amount: 50, currency: "EUR" },
        selling_price: { amount: 100, currency: "EUR" },
        unit_of_measure_id: "unit-1",
        price_list_prices: [
          { price_list_id: "price-list-1", price: { amount: 90, currency: "EUR" } },
        ],
        stock: { amount: 12 },
        configuration: { stock_threshold: { minimum: 4, action: "notify" } },
        department_id: "department-1",
        product_category_id: "category-1",
        tax_rate_id: "tax-rate-1",
        custom_fields: [{ id: "field-1", value: "external-reference" }],
      },
      {
        id: "product-1",
        name: "Updated hosting",
        code: null,
        description: null,
        purchase_price: null,
        selling_price: { amount: 120, currency: "EUR" },
        unit_of_measure_id: null,
        price_list_prices: [
          { price_list_id: "price-list-1", price: { amount: 110, currency: "EUR" } },
        ],
        stock: { amount: 10 },
        configuration: null,
        department_id: "department-1",
        product_category_id: "category-1",
        tax_rate_id: "tax-rate-1",
        custom_fields: [{ id: "field-1", value: "updated-reference" }],
      },
      { id: "product-1" },
    ])
  })

  test("exposes quotation reference endpoints", async () => {
    const requests: CapturedRequest[] = []
    const client = createTeamleaderClient({
      accessToken: "test-token",
      fetch: mockFetch((input, init) => {
        requests.push({ input, init })
        const path = new URL(String(input)).pathname

        if (path === "/products.info") {
          return Promise.resolve(jsonResponse({ data: { id: "product-1", name: "Product" } }))
        }

        if (path === "/paymentTerms.list") {
          return Promise.resolve(
            jsonResponse({ data: [{ id: "term-1" }], meta: { default: "term-1" } })
          )
        }

        return Promise.resolve(jsonResponse({ data: [] }))
      }),
    })

    await client.products.list({ filter: { term: "kitchen" }, page: { size: 20 } })
    await client.products.info({ id: "product-1", includes: "suppliers" })
    await client.productCategories.list({ filter: { department_id: "department-1" } })
    await client.priceLists.list({ filter: { ids: ["price-list-1"] } })
    await client.taxRates.list({ filter: { department_id: "department-1" } })
    await client.unitsOfMeasure.list()
    const paymentTerms = await client.paymentTerms.list()
    await client.paymentMethods.list({ filter: { status: ["active"] }, page: { size: 20 } })
    await client.documentTemplates.list({
      filter: {
        department_id: "department-1",
        document_type: "quotation",
        status: ["active"],
      },
    })

    expect(paymentTerms.meta?.default).toBe("term-1")
    expect(requests.map((request) => new URL(String(request.input)).pathname)).toEqual([
      "/products.list",
      "/products.info",
      "/productCategories.list",
      "/priceLists.list",
      "/taxRates.list",
      "/unitsOfMeasure.list",
      "/paymentTerms.list",
      "/paymentMethods.list",
      "/documentTemplates.list",
    ])
    expect(requests.map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      { filter: { term: "kitchen" }, page: { size: 20 } },
      { id: "product-1", includes: "suppliers" },
      { filter: { department_id: "department-1" } },
      { filter: { ids: ["price-list-1"] } },
      { filter: { department_id: "department-1" } },
      {},
      {},
      { filter: { status: ["active"] }, page: { size: 20 } },
      {
        filter: {
          department_id: "department-1",
          document_type: "quotation",
          status: ["active"],
        },
      },
    ])
  })

  test("paginates listAll requests", async () => {
    const requestedPages: number[] = []
    const client = createTeamleaderClient({
      accessToken: "test-token",
      fetch: mockFetch((_, init) => {
        const body = JSON.parse(String(init?.body))
        const pageNumber = body.page.number
        requestedPages.push(pageNumber)

        return Promise.resolve(
          jsonResponse({
            data:
              pageNumber === 1 ? [{ id: "contact-1" }, { id: "contact-2" }] : [{ id: "contact-3" }],
            meta: {
              matches: 3,
              page: { size: 2, number: pageNumber },
            },
          })
        )
      }),
    })

    const contacts = []
    for await (const contact of client.contacts.listAll(
      { filter: { status: "active" } },
      { pageSize: 2 }
    )) {
      contacts.push(contact)
    }

    expect(requestedPages).toEqual([1, 2])
    expect(contacts.map((contact) => contact.id)).toEqual(["contact-1", "contact-2", "contact-3"])
  })

  test("throws TeamleaderApiError for API errors", async () => {
    const client = createTeamleaderClient({
      accessToken: "test-token",
      fetch: mockFetch(() =>
        Promise.resolve(
          jsonResponse(
            {
              errors: [{ title: "Deal not found" }],
            },
            { status: 404 }
          )
        )
      ),
    })

    try {
      await client.deals.info({ id: "missing" })
      throw new Error("Expected request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(TeamleaderApiError)
      expect((error as TeamleaderApiError).status).toBe(404)
      expect((error as TeamleaderApiError).errors).toEqual([{ title: "Deal not found" }])
      expect((error as Error).message).toContain("Deal not found")
    }
  })

  test("registers and unregisters outgoing webhooks", async () => {
    const bodies: unknown[] = []
    const client = createTeamleaderClient({
      accessToken: "test-token",
      fetch: mockFetch((_, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Promise.resolve(new Response(undefined, { status: 204 }))
      }),
    })

    const registration = {
      url: "https://example.com/teamleader",
      types: ["deal.updated", "company.updated"] as const,
    }

    await client.webhooks.register(registration)
    await client.webhooks.unregister(registration)

    expect(bodies).toEqual([registration, registration])
  })

  test("forwards connector webhook definitions", () => {
    const webhook = defineTeamleaderWebhook("events").handle(() => {})
    const adapter = teamleader({
      accessToken: "test-token",
      webhooks: [webhook],
    })

    expect(adapter.webhooks).toEqual([webhook])
  })
})

describe("custom field helpers", () => {
  const customFields: TeamleaderCustomField[] = [
    {
      definition: { type: "customFieldDefinition", id: "field-1" },
      value: "Alpha",
    },
    {
      definition: { type: "customFieldDefinition", id: "field-2" },
      value: 42,
    },
  ]

  const definitions: TeamleaderCustomFieldDefinition[] = [
    { id: "field-1", label: "Region" },
    { id: "field-2", label: "Score" },
  ]

  test("maps custom fields by definition id", () => {
    expect([...customFieldsByDefinitionId(customFields)]).toEqual([
      ["field-1", "Alpha"],
      ["field-2", 42],
    ])
  })

  test("maps custom fields by label", () => {
    expect([...customFieldsByLabel(customFields, definitions)]).toEqual([
      ["Region", "Alpha"],
      ["Score", 42],
    ])
  })
})

describe("defineTeamleaderWebhook", () => {
  test("keeps webhook body unknown unless a generic is provided", () => {
    const webhook = defineTeamleaderWebhook("events").handle(({ body }) => ({
      status: 200,
      body: { received: typeof body },
    }))

    expect(webhook.kind).toBe("webhook")
    expect(webhook.method).toBe("POST")
    expect(webhook.body.format).toBe("json")
    expect(webhook.body.parse({ type: "deal.updated" })).toEqual({ type: "deal.updated" })
  })

  test("supports TypeScript-only body typing", async () => {
    type DealUpdatedBody = {
      readonly type: "deal.updated"
      readonly subject: {
        readonly type: "deal"
        readonly id: string
      }
    }

    const webhook = defineTeamleaderWebhook<DealUpdatedBody>("events")
      .idempotencyKey(({ body }) => body.subject.id)
      .handle(({ body }) => ({
        status: 200,
        body: { id: body.subject.id },
      }))

    const body = webhook.body.parse({
      type: "deal.updated",
      subject: { type: "deal", id: "deal-1" },
    })
    const idempotencyKey = await webhook.idempotencyKey?.({
      body,
      rawBody: new Uint8Array(),
      request: new Request("https://example.com"),
      logger: noopLogger,
      sixb: {} as never,
      connector: {} as never,
      webhook: {
        id: "events",
        method: "POST",
        route: "/api/webhooks/teamleader/events",
        bodyFormat: "json",
      },
    })

    expect(idempotencyKey).toBe("deal-1")
  })
})
