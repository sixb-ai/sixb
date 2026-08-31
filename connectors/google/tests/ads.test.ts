import { afterEach, describe, expect, test } from "bun:test"
import type { ConnectorContext } from "@sixb/core"
import {
  GOOGLE_ADS_SCOPE,
  GoogleAdsApiError,
  type GoogleAdsClient,
  type GoogleAdsConnectorOptions,
  GoogleAdsProtocolError,
  googleAds,
} from "../src"
import { collect, restoreFetch } from "./helpers"

const CONTEXT: ConnectorContext = {
  projectId: "demo",
  connectorId: "google-ads",
  signal: new AbortController().signal,
}

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body?: string
  readonly signal?: AbortSignal | null
}

function response(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers as object | undefined) },
  })
}

function recorder(responses: readonly Response[]): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  let call = 0
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
      signal: init?.signal,
    })
    const next = responses[call++]
    if (!next) {
      throw new Error(`Unexpected fetch call ${call}.`)
    }
    return Promise.resolve(next)
  }) as typeof fetch
  return requests
}

function options(overrides: Partial<GoogleAdsConnectorOptions> = {}): GoogleAdsConnectorOptions {
  return {
    auth: { token: () => "access-token" },
    developerToken: "developer-token",
    loginCustomerId: "123-456-7890",
    ...overrides,
  }
}

async function connect(overrides?: Partial<GoogleAdsConnectorOptions>): Promise<GoogleAdsClient> {
  return googleAds(options(overrides)).connect(CONTEXT)
}

afterEach(restoreFetch)

describe("googleAds configuration", () => {
  test("validates developer token, manager ID, major version, and OAuth scope eagerly", () => {
    expect(() => googleAds(options({ developerToken: "  " }))).toThrow(
      "developerToken must not be empty"
    )
    expect(() => googleAds(options({ loginCustomerId: "123" }))).toThrow(
      "10-digit Google Ads customer ID"
    )
    expect(() =>
      googleAds(options({ apiVersion: "v25.1" as GoogleAdsConnectorOptions["apiVersion"] }))
    ).toThrow("major endpoint")
    expect(() =>
      googleAds(
        options({
          auth: {
            serviceAccountKey: { client_email: "service@example.com", private_key: "key" },
            scopes: ["https://www.googleapis.com/auth/drive.readonly"],
          },
        })
      )
    ).toThrow(GOOGLE_ADS_SCOPE)
  })

  test("accepts the required Google Ads scope for service-account auth", () => {
    expect(() =>
      googleAds(
        options({
          auth: {
            serviceAccountKey: { client_email: "service@example.com", private_key: "key" },
            scopes: [GOOGLE_ADS_SCOPE],
          },
        })
      )
    ).not.toThrow()
  })
})

describe("googleAds customers", () => {
  test("lists direct grants without sending the ignored login-customer-id header", async () => {
    const requests = recorder([
      response({ resourceNames: ["customers/1234567890", "customers/9876543210"] }),
    ])
    const client = await connect()

    const resourceNames = await client.customers.listAccessible()

    expect(resourceNames).toEqual(["customers/1234567890", "customers/9876543210"])
    expect(requests[0]?.url).toBe(
      "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers"
    )
    expect(requests[0]?.method).toBe("GET")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer access-token")
    expect(requests[0]?.headers.get("developer-token")).toBe("developer-token")
    expect(requests[0]?.headers.has("login-customer-id")).toBe(false)
  })

  test("lists enabled leaf advertisers through the configured MCC across every page", async () => {
    const requests = recorder([
      response({
        results: [
          {
            customerClient: {
              clientCustomer: "customers/1111111111",
              id: "1111111111",
              level: "1",
              manager: false,
              descriptiveName: "Client One",
              currencyCode: "EUR",
              timeZone: "Europe/Paris",
              status: "ENABLED",
            },
          },
        ],
        nextPageToken: "page-2",
      }),
      response({
        results: [
          {
            customerClient: {
              id: "2222222222",
              level: "2",
              manager: false,
              status: "ENABLED",
              currencyCode: "USD",
            },
          },
        ],
      }),
    ])
    const client = await connect()

    const customers = await collect(client.customers.listManaged())

    expect(customers.map((customer) => customer.id)).toEqual(["1111111111", "2222222222"])
    expect(customers[0]?.level).toBe("1")
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe(
      "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search"
    )
    expect(requests[0]?.headers.get("login-customer-id")).toBe("1234567890")

    const firstBody = JSON.parse(requests[0]?.body ?? "{}")
    const secondBody = JSON.parse(requests[1]?.body ?? "{}")
    expect(firstBody.query).toContain("FROM customer_client")
    expect(firstBody.query).toContain("customer_client.level > 0")
    expect(firstBody.query).toContain("customer_client.manager = FALSE")
    expect(firstBody.query).toContain("customer_client.status = ENABLED")
    expect(secondBody.query).toBe(firstBody.query)
    expect(secondBody.pageToken).toBe("page-2")
  })
})

describe("googleAds reports", () => {
  test("keeps login and operating customer IDs separate and preserves int64 strings", async () => {
    const requests = recorder([
      response({
        results: [
          {
            campaign: { id: "9007199254740993", name: "Search" },
            metrics: { impressions: "42", costMicros: "1234567" },
          },
        ],
        totalResultsCount: "1",
        queryResourceConsumption: "17",
      }),
    ])
    const client = await connect()
    const query = "SELECT campaign.id, metrics.impressions FROM campaign"

    const page = await client.customer("customers/987-654-3210").reports.search({
      query,
      searchSettings: { returnTotalResultsCount: true },
    })

    expect(requests[0]?.url).toBe(
      "https://googleads.googleapis.com/v25/customers/9876543210/googleAds:search"
    )
    expect(requests[0]?.headers.get("login-customer-id")).toBe("1234567890")
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      query,
      searchSettings: { returnTotalResultsCount: true },
    })
    expect(page.results?.[0]?.campaign).toEqual({
      id: "9007199254740993",
      name: "Search",
    })
    expect(page.results?.[0]?.metrics?.costMicros).toBe("1234567")
    expect(page.queryResourceConsumption).toBe("17")
  })

  test("searchAll refuses a repeated pagination token", async () => {
    recorder([
      response({ results: [{ campaign: { id: "1" } }], nextPageToken: "same" }),
      response({ results: [{ campaign: { id: "2" } }], nextPageToken: "same" }),
    ])
    const client = await connect()

    const result = collect(
      client.customer("9876543210").reports.searchAll({
        query: "SELECT campaign.id FROM campaign",
      })
    )

    await expect(result).rejects.toThrow("repeated page token")
  })

  test("mirrors SearchStream's JSON batch array", async () => {
    const requests = recorder([
      response([
        { results: [{ campaign: { id: "1" } }], requestId: "stream-request" },
        { results: [{ campaign: { id: "2" } }], queryResourceConsumption: "9" },
      ]),
    ])
    const client = await connect()

    const batches = await client.customer("9876543210").reports.searchStream({
      query: "SELECT campaign.id FROM campaign",
      summaryRowSetting: "SUMMARY_ROW_WITH_RESULTS",
    })

    expect(batches).toHaveLength(2)
    expect(batches[0]?.requestId).toBe("stream-request")
    expect(requests[0]?.url).toEndWith("/customers/9876543210/googleAds:searchStream")
    expect(JSON.parse(requests[0]?.body ?? "{}").summaryRowSetting).toBe("SUMMARY_ROW_WITH_RESULTS")
  })

  test("builds the account-local daily performance GAQL", async () => {
    const requests = recorder([
      response({
        results: [
          {
            customer: { id: "9876543210", currencyCode: "EUR", timeZone: "Europe/Paris" },
            segments: { date: "2026-08-01" },
            metrics: { impressions: "10", conversions: 1.5, costMicros: "500000" },
          },
        ],
      }),
    ])
    const client = await connect()

    const rows = await collect(
      client.customer("9876543210").reports.customerDaily({
        startDate: "2026-08-01",
        endDate: "2026-08-23",
      })
    )

    const query = JSON.parse(requests[0]?.body ?? "{}").query as string
    expect(query).toContain("FROM customer")
    expect(query).toContain("metrics.cost_micros")
    expect(query).toContain("metrics.view_through_conversions")
    expect(query).toContain("BETWEEN '2026-08-01' AND '2026-08-23'")
    expect(rows[0]?.metrics.impressions).toBe("10")
    expect(rows[0]?.metrics.conversions).toBe(1.5)
  })

  test("rejects unsupported page sizes and invalid dates before fetch", async () => {
    let called = false
    globalThis.fetch = (() => {
      called = true
      return Promise.resolve(response({}))
    }) as unknown as typeof fetch
    const client = await connect()
    const reports = client.customer("9876543210").reports

    expect(() =>
      reports.search({
        query: "SELECT campaign.id FROM campaign",
        pageSize: 100,
      } as never)
    ).toThrow("fixed at 10,000")
    expect(() => reports.customerDaily({ startDate: "2026-02-30", endDate: "2026-03-01" })).toThrow(
      "valid calendar date"
    )
    expect(called).toBe(false)
  })
})

describe("googleAds reliability", () => {
  test("exposes granular GoogleAdsFailure details and the response request ID", async () => {
    recorder([
      response(
        {
          error: {
            code: 400,
            message: "Request contains an invalid argument.",
            status: "INVALID_ARGUMENT",
            details: [
              {
                "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
                requestId: "body-request",
                errors: [
                  {
                    errorCode: { queryError: "PROHIBITED_FIELD_COMBINATION_IN_SELECT_CLAUSE" },
                    message: "The fields cannot be selected together.",
                    location: { fieldPathElements: [{ fieldName: "query" }] },
                  },
                ],
              },
            ],
          },
        },
        { status: 400, headers: { "request-id": "header-request" } }
      ),
    ])
    const client = await connect()

    const error = (await client
      .customer("9876543210")
      .reports.search({ query: "SELECT bad FROM customer" })
      .catch((caught) => caught)) as GoogleAdsApiError

    expect(error).toBeInstanceOf(GoogleAdsApiError)
    expect(error.status).toBe(400)
    expect(error.requestId).toBe("header-request")
    expect(error.errors).toHaveLength(1)
    expect(error.errors[0]?.location?.fieldPathElements?.[0]?.fieldName).toBe("query")
    expect(error.message).toContain("PROHIBITED_FIELD_COMBINATION_IN_SELECT_CLAUSE")
    expect(error.message).toContain("header-request")
  })

  test("refreshes once after 401 and retries transient 429 responses", async () => {
    let tokenCalls = 0
    const requests = recorder([
      response({ error: { message: "expired" } }, { status: 401 }),
      response(
        { error: { message: "rate limited" } },
        { status: 429, headers: { "Retry-After": "0" } }
      ),
      response({ resourceNames: ["customers/1234567890"] }),
    ])
    const client = await connect({
      auth: { token: () => (tokenCalls++ === 0 ? "old-token" : "fresh-token") },
    })

    const result = await client.customers.listAccessible()

    expect(result).toEqual(["customers/1234567890"])
    expect(requests).toHaveLength(3)
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer old-token")
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer fresh-token")
    expect(requests[2]?.headers.get("authorization")).toBe("Bearer fresh-token")
  })

  test("keeps Google Ads retry defaults when one retry hook is overridden", async () => {
    const requests = recorder([
      response({ error: { message: "temporarily unavailable" } }, { status: 503 }),
      response({ resourceNames: ["customers/1234567890"] }),
    ])
    const client = await connect({ retry: { delayMs: () => 0 } })

    const result = await client.customers.listAccessible()

    expect(result).toEqual(["customers/1234567890"])
    expect(requests).toHaveLength(2)
  })

  test("forwards ConnectorContext.signal to every request", async () => {
    const controller = new AbortController()
    const context = { ...CONTEXT, signal: controller.signal }
    const requests = recorder([response({ resourceNames: [] })])
    const client = await googleAds(options()).connect(context)

    await client.customers.listAccessible()

    expect(requests[0]?.signal).toBe(controller.signal)
  })

  test("uses a protocol error for malformed successful response envelopes", async () => {
    recorder([response({ results: [] }), response({ resourceNames: "not-an-array" })])
    const client = await connect()

    const stream = client
      .customer("9876543210")
      .reports.searchStream({ query: "SELECT customer.id FROM customer" })

    await expect(stream).rejects.toBeInstanceOf(GoogleAdsProtocolError)
    await expect(stream).rejects.toThrow("expected an array of objects")
    await expect(client.customers.listAccessible()).rejects.toBeInstanceOf(GoogleAdsProtocolError)
  })
})
