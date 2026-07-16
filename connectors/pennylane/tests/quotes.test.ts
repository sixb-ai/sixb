import { afterEach, describe, expect, test } from "bun:test"
import { PennylaneApiError } from "../src"
import { collect, createTestClient, empty, json, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("pennylane quotes", () => {
  test("lists quotes with bearer auth and typed filters", async () => {
    let requestUrl = ""
    let requestHeaders = new Headers()
    let requestSignal: AbortSignal | null | undefined
    mockFetch((input, init) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      requestSignal = init?.signal
      return Promise.resolve(json({ items: [], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient()
    await client.quotes.list({
      limit: 100,
      sort: "id",
      filter: [
        { field: "customer_id", operator: "in", value: [42, 43] },
        { field: "status", operator: "eq", value: "accepted" },
      ],
    })

    const url = new URL(requestUrl)
    expect(url.origin).toBe("https://app.pennylane.com")
    expect(url.pathname).toBe("/api/external/v2/quotes")
    expect(url.searchParams.get("limit")).toBe("100")
    expect(url.searchParams.get("sort")).toBe("id")
    expect(JSON.parse(url.searchParams.get("filter") ?? "")).toEqual([
      { field: "customer_id", operator: "in", value: [42, 43] },
      { field: "status", operator: "eq", value: "accepted" },
    ])
    expect(requestHeaders.get("authorization")).toBe("Bearer pl-token")
    expect(requestHeaders.get("accept")).toBe("application/json")
    expect(requestSignal).toBeInstanceOf(AbortSignal)
  })

  test("listAll repeats filters and sort while following opaque cursors", async () => {
    const requests: URL[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      requests.push(url)
      const cursor = url.searchParams.get("cursor")

      return Promise.resolve(
        json(
          cursor === null
            ? { items: [{ id: 1 }], has_more: true, next_cursor: "opaque+cursor==" }
            : { items: [{ id: 2 }], has_more: false, next_cursor: null }
        )
      )
    })

    const client = await createTestClient()
    const quotes = await collect(
      client.quotes.listAll({
        limit: 1,
        sort: "-id",
        filter: [{ field: "status", operator: "not_eq", value: "denied" }],
      })
    )

    expect(quotes.map((quote) => quote.id)).toEqual([1, 2])
    expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "opaque+cursor=="])
    expect(requests.map((url) => url.searchParams.get("sort"))).toEqual(["-id", "-id"])
    expect(requests[0]?.searchParams.get("filter")).toBe(requests[1]?.searchParams.get("filter"))
  })

  test("uses exact detail and child-resource paths", async () => {
    const paths: string[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      paths.push(`${url.pathname}${url.search}`)
      if (url.pathname === "/api/external/v2/quotes/42") {
        return Promise.resolve(json({ id: 42 }))
      }
      return Promise.resolve(json({ items: [], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient()
    await client.quotes.get(42)
    await client.quotes.listInvoiceLineSections(42, { limit: 20, sort: "id" })
    await client.quotes.listInvoiceLines(42, { cursor: "next", sort: "-id" })
    await client.quotes.listAppendices(42, { limit: 10 })

    expect(paths).toEqual([
      "/api/external/v2/quotes/42",
      "/api/external/v2/quotes/42/invoice_line_sections?limit=20&sort=id",
      "/api/external/v2/quotes/42/invoice_lines?cursor=next&sort=-id",
      "/api/external/v2/quotes/42/appendices?limit=10",
    ])
  })

  test("sends documented quote write payloads and methods", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = []
    mockFetch((input, init) => {
      const path = new URL(String(input)).pathname
      requests.push({
        path,
        method: init?.method ?? "",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (path.endsWith("/send_by_email")) {
        return Promise.resolve(empty())
      }
      return Promise.resolve(json({ id: 42 }))
    })

    const client = await createTestClient()
    await client.quotes.create({
      date: "2026-07-10",
      deadline: "2026-08-10",
      customer_id: 7,
      external_reference: "CRM-42",
      invoice_lines: [
        {
          label: "Implementation",
          quantity: 2,
          raw_currency_unit_price: "500.00",
          unit: "day",
          vat_rate: "FR_200",
        },
      ],
    })
    await client.quotes.update(42, {
      pdf_invoice_subject: "Updated quote",
      invoice_lines: {
        update: [{ id: 3, quantity: 3 }],
        delete: [{ id: 4 }],
      },
    })
    await client.quotes.updateStatus(42, { status: "accepted" })
    await client.quotes.sendByEmail(42, { recipients: ["customer@example.com"] })

    expect(requests).toEqual([
      {
        path: "/api/external/v2/quotes",
        method: "POST",
        body: {
          date: "2026-07-10",
          deadline: "2026-08-10",
          customer_id: 7,
          external_reference: "CRM-42",
          invoice_lines: [
            {
              label: "Implementation",
              quantity: 2,
              raw_currency_unit_price: "500.00",
              unit: "day",
              vat_rate: "FR_200",
            },
          ],
        },
      },
      {
        path: "/api/external/v2/quotes/42",
        method: "PUT",
        body: {
          pdf_invoice_subject: "Updated quote",
          invoice_lines: { update: [{ id: 3, quantity: 3 }], delete: [{ id: 4 }] },
        },
      },
      {
        path: "/api/external/v2/quotes/42/update_status",
        method: "PUT",
        body: { status: "accepted" },
      },
      {
        path: "/api/external/v2/quotes/42/send_by_email",
        method: "POST",
        body: { recipients: ["customer@example.com"] },
      },
    ])
  })

  test("uploads appendices as multipart without overriding the boundary", async () => {
    let requestBody: BodyInit | null | undefined
    let contentType: string | null = "unexpected"
    mockFetch((_input, init) => {
      requestBody = init?.body
      contentType = new Headers(init?.headers).get("content-type")
      return Promise.resolve(
        json({
          id: 9,
          filename: "terms.pdf",
          url: "https://example.test/terms.pdf",
          created_at: "2026-07-10T10:00:00Z",
          updated_at: "2026-07-10T10:00:00Z",
        })
      )
    })

    const client = await createTestClient()
    const appendix = await client.quotes.uploadAppendix(42, {
      file: new Blob(["%PDF"], { type: "application/pdf" }),
      filename: "terms.pdf",
    })

    expect(requestBody).toBeInstanceOf(FormData)
    expect(contentType).toBeNull()
    const uploaded = (requestBody as FormData).get("file")
    expect(uploaded).toBeInstanceOf(File)
    expect((uploaded as File).name).toBe("terms.pdf")
    expect(appendix.id).toBe(9)
  })

  test("exposes quote changelogs and enforces mutually exclusive cursors", async () => {
    const requested: URL[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      requested.push(url)
      return Promise.resolve(
        json(
          requested.length === 1
            ? { items: [{ id: 1 }], has_more: true, next_cursor: "change-cursor" }
            : { items: [{ id: 2 }], has_more: false, next_cursor: null }
        )
      )
    })

    const client = await createTestClient()
    const changes = await collect(
      client.quoteChanges.listAll({ limit: 1000, start_date: "2026-07-01T00:00:00Z" })
    )

    expect(changes.map((change) => change.id)).toEqual([1, 2])
    expect(requested.map((url) => url.pathname)).toEqual([
      "/api/external/v2/changelogs/quotes",
      "/api/external/v2/changelogs/quotes",
    ])
    expect(requested[0]?.searchParams.get("limit")).toBe("1000")
    expect(requested[0]?.searchParams.get("start_date")).toBe("2026-07-01T00:00:00Z")
    expect(requested[0]?.searchParams.get("cursor")).toBeNull()
    expect(requested[1]?.searchParams.get("start_date")).toBeNull()
    expect(requested[1]?.searchParams.get("cursor")).toBe("change-cursor")

    const invalidOptions = { cursor: "next", start_date: "2026-07-01T00:00:00Z" }
    expect(() => client.quoteChanges.list(invalidOptions as never)).toThrow("mutually exclusive")
  })

  test("validates identifiers, limits, cursors, and empty uploads before fetch", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(json({ items: [], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient()
    expect(() => client.quotes.get(0)).toThrow("positive safe integer")
    expect(() => client.quotes.list({ limit: 101 })).toThrow("between 1 and 100")
    expect(() => client.quotes.list({ cursor: " " })).toThrow("cursor must not be empty")
    expect(() =>
      client.quotes.uploadAppendix(1, { file: new Blob([]), filename: "empty.pdf" })
    ).toThrow("must not be empty")
    expect(calls).toBe(0)
  })

  test("surfaces structured API errors", async () => {
    mockFetch(() =>
      Promise.resolve(
        json(
          { error: "too_many_requests", message: "Slow down" },
          {
            status: 429,
            headers: { "retry-after": "2", "x-request-id": "req-42" },
          }
        )
      )
    )

    const client = await createTestClient({ retry: { maxRetries: 0 } })
    const error = await client.quotes.list().catch((caught) => caught)

    expect(error).toBeInstanceOf(PennylaneApiError)
    expect(error.status).toBe(429)
    expect(error.responseBody).toEqual({ error: "too_many_requests", message: "Slow down" })
    expect(error.retryAfterMs).toBe(2000)
    expect(error.requestId).toBe("req-42")
    expect(error.message).toContain("too_many_requests: Slow down")
  })
})
