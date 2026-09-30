import { afterEach, describe, expect, test } from "bun:test"
import { AgentToolPublicError } from "@sixb/core"
import { FullEnrichApiError, fullenrich } from "../src"
import {
  API_KEY,
  apiError,
  COMPANY,
  calls,
  connect,
  ENRICHMENT,
  mockFetch,
  PERSON,
  restoreFetch,
} from "./helpers"

afterEach(restoreFetch)

const BASE = "https://app.fullenrich.com/api/v2"

describe("FullEnrich transport", () => {
  test("connects lazily and authenticates every request with a resolved bearer key", async () => {
    mockFetch(() => Response.json({ balance: 5000 }))
    let key = "first"
    const client = await connect({ apiKey: async () => key })
    expect(calls).toHaveLength(0)

    expect(await client.account.credits()).toEqual({ balance: 5000 })
    key = "second"
    await client.account.credits()

    expect(calls.map((call) => call.url.toString())).toEqual([
      `${BASE}/account/credits`,
      `${BASE}/account/credits`,
    ])
    expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer first",
      "Bearer second",
    ])
  })

  test("rejects invalid configuration before connecting", () => {
    expect(() => fullenrich({ apiKey: " " })).toThrow("apiKey must be a non-empty")
    expect(() => fullenrich({ apiKey: API_KEY, baseUrl: "ftp://example.com" })).toThrow(
      "baseUrl must be an absolute HTTP(S) URL"
    )
    expect(() => fullenrich({ apiKey: API_KEY, maxRetries: 11 })).toThrow(
      "maxRetries must be an integer from 0 to 10"
    )
  })

  test("honors a custom base URL without a trailing slash", async () => {
    mockFetch(() => Response.json({ workspace_id: "ws_1" }))
    const client = await connect({ baseUrl: "https://proxy.example/fullenrich/v2" })

    expect(await client.account.verifyKey()).toEqual({ workspace_id: "ws_1" })
    expect(calls[0]?.url.toString()).toBe("https://proxy.example/fullenrich/v2/account/keys/verify")
  })

  test("surfaces the provider's code and message as a public API error", async () => {
    mockFetch(() => apiError(401, "error.api.key", "Unknown api key"))
    const client = await connect()

    const error = await client.account.credits().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FullEnrichApiError)
    expect(error).toBeInstanceOf(AgentToolPublicError)
    expect(error).toMatchObject({ status: 401, code: "error.api.key" })
    expect((error as Error).message).toBe(
      "[SixbFullEnrich] FullEnrich credit balance failed with HTTP 401 (error.api.key): Unknown api key."
    )
  })

  test("wraps network failures and keeps caller cancellation as the abort reason", async () => {
    mockFetch(() => {
      throw new TypeError("connection refused")
    })
    const client = await connect({ maxRetries: 0 })
    await expect(client.account.credits()).rejects.toThrow(
      "FullEnrich credit balance could not reach the API"
    )

    const controller = new AbortController()
    const reason = new Error("stopped")
    controller.abort(reason)
    await expect(client.account.credits({ signal: controller.signal })).rejects.toBe(reason)
  })

  // Guard proof: mark job starts `idempotent: true` in the resources; the start assertion fails.
  test("retries reads on 429 but never replays a job start", async () => {
    let attempts = 0
    mockFetch((call) => {
      attempts += 1
      if (call.url.pathname.endsWith("/people/search") && attempts > 1) {
        return Response.json({ people: [] })
      }
      // Retry-After keeps a regressed job-start retry from waiting for the next minute window.
      return Response.json(
        { code: "error.rate.limit", message: "Too many requests. Try again in 1m" },
        { status: 429, headers: { "retry-after": "0" } }
      )
    })
    const client = await connect()

    await client.people.search({ limit: 1 })
    expect(attempts).toBe(2)

    attempts = 0
    await expect(
      client.enrichments.start({
        name: "Once",
        data: [
          {
            linkedin_url: "https://www.linkedin.com/in/demoge/",
            enrich_fields: ["contact.phones"],
          },
        ],
      })
    ).rejects.toMatchObject({ status: 429, code: "error.rate.limit" })
    expect(attempts).toBe(1)
  })
})

describe("FullEnrich contact enrichment", () => {
  test("starts a bulk enrichment with webhooks and silentFail", async () => {
    mockFetch(() => Response.json({ enrichment_id: ENRICHMENT.id }))
    const client = await connect()
    const request = {
      name: "Sales Operations in London",
      webhook_url: "https://example.com/webhook",
      webhook_events: { contact_finished: "https://example.com/webhook/contact" },
      data: [
        {
          first_name: "John",
          last_name: "Snow",
          domain: "example.com",
          enrich_fields: ["contact.work_emails", "contact.phones"] as const,
          custom: { user_id: "12584" },
        },
      ],
    }

    expect(await client.enrichments.start(request, { silentFail: true })).toEqual({
      enrichment_id: ENRICHMENT.id,
    })
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url.toString()).toBe(`${BASE}/contact/enrich/bulk?silentFail=true`)
    expect(calls[0]?.body).toEqual(request)
  })

  test("validates batches before sending them", async () => {
    mockFetch(() => Response.json({ enrichment_id: "unused" }))
    const client = await connect()
    const contact = { linkedin_url: "https://www.linkedin.com/in/demoge/" }

    await expect(
      client.enrichments.start({ name: "x", data: [{ ...contact, enrich_fields: [] }] })
    ).rejects.toThrow("data[0].enrich_fields must list one or more")
    await expect(
      client.enrichments.start({
        name: "x",
        data: [
          {
            ...contact,
            enrich_fields: ["contact.phones"],
            custom: { id: 1 as unknown as string },
          },
        ],
      })
    ).rejects.toThrow("data[0].custom must be an object with string values")
    await expect(client.enrichments.start({ name: "x", data: [] })).rejects.toThrow(
      "data must contain from 1 to 100 entries"
    )
    await expect(
      client.enrichments.start({
        name: "x",
        webhook_url: "javascript:alert(1)",
        data: [{ ...contact, enrich_fields: ["contact.phones"] }],
      })
    ).rejects.toThrow("webhook_url must be an absolute HTTP(S) URL")
    expect(calls).toHaveLength(0)
  })

  test("reads a result, forces partial results, and returns the 402 credit shortfall body", async () => {
    const shortfall = { ...ENRICHMENT, status: "CREDITS_INSUFFICIENT" }
    mockFetch((call) =>
      call.url.searchParams.has("forceResults")
        ? Response.json(shortfall, { status: 402 })
        : Response.json(ENRICHMENT)
    )
    const client = await connect()

    expect(await client.enrichments.get(ENRICHMENT.id)).toEqual(ENRICHMENT as never)
    expect(await client.enrichments.get(ENRICHMENT.id, { forceResults: true })).toEqual(
      shortfall as never
    )
    expect(calls.map((call) => call.url.toString())).toEqual([
      `${BASE}/contact/enrich/bulk/${ENRICHMENT.id}`,
      `${BASE}/contact/enrich/bulk/${ENRICHMENT.id}?forceResults=true`,
    ])
  })

  test("reports a running enrichment as an in-progress API error", async () => {
    mockFetch(() =>
      apiError(400, "error.enrichment.in_progress", "Enrichment not ready, try again in 30 seconds")
    )
    const client = await connect()

    await expect(client.enrichments.get("id/../other")).rejects.toMatchObject({
      status: 400,
      code: "error.enrichment.in_progress",
    })
    expect(calls[0]?.url.pathname).toBe("/api/v2/contact/enrich/bulk/id%2F..%2Fother")
  })
})

describe("FullEnrich reverse email lookup", () => {
  test("starts and reads a lookup", async () => {
    const lookup = {
      id: "lookup-1",
      name: "Reverse",
      status: "FINISHED",
      cost: { credits: 1 },
      data: [{ input: { email: "john.snow@example.com" }, profile: PERSON }],
    }
    mockFetch((call) =>
      call.method === "POST" ? Response.json({ enrichment_id: "lookup-1" }) : Response.json(lookup)
    )
    const client = await connect()

    expect(
      await client.reverseEmailLookups.start({
        name: "Reverse",
        data: [{ email: "john.snow@example.com" }],
      })
    ).toEqual({ enrichment_id: "lookup-1" })
    expect(await client.reverseEmailLookups.get("lookup-1")).toEqual(lookup as never)
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /api/v2/contact/reverse/email/bulk",
      "GET /api/v2/contact/reverse/email/bulk/lookup-1",
    ])
    await expect(
      client.reverseEmailLookups.start({ name: "Reverse", data: [{ email: " " }] })
    ).rejects.toThrow("data[0].email must be a non-empty string")
  })
})

describe("FullEnrich search and lookup", () => {
  test("posts people filters verbatim and returns people with metadata", async () => {
    mockFetch(() =>
      Response.json({
        people: [PERSON],
        metadata: { total: 42, credits: 0.25, offset: 0, search_after: "cursor-2" },
      })
    )
    const client = await connect()
    const request = {
      limit: 1,
      current_position_titles: [{ value: "Head of Sales", exact_match: false }],
      current_company_headcounts: [{ min: 50, max: 500 }],
      person_locations: [{ value: "France", exclude: true }],
    }

    const response = await client.people.search(request)

    expect(response.people).toEqual([PERSON] as never)
    expect(response.metadata).toEqual({
      total: 42,
      credits: 0.25,
      offset: 0,
      search_after: "cursor-2",
    })
    expect(calls[0]?.url.pathname).toBe("/api/v2/people/search")
    expect(calls[0]?.body).toEqual(request)
    await expect(client.people.search({ limit: 101 })).rejects.toThrow(
      "limit must be an integer from 1 to 100"
    )
    await expect(client.people.search({ offset: 10_001 })).rejects.toThrow(
      "offset must be an integer from 0 to 10000"
    )
  })

  // Guard proof: drop the `seen` check in pagination.ts; the repeated cursor loops forever.
  test("searchAll follows search_after and stops on a short page or a repeated cursor", async () => {
    const pages = [
      { companies: [COMPANY, COMPANY], metadata: { search_after: "a" } },
      { companies: [COMPANY, COMPANY], metadata: { search_after: "b" } },
      { companies: [COMPANY], metadata: { search_after: "c" } },
    ]
    mockFetch(() => Response.json(pages[calls.length - 1]))
    const client = await connect()

    const companies = []
    for await (const company of client.companies.searchAll({ limit: 2, offset: 4 })) {
      companies.push(company)
    }

    expect(companies).toHaveLength(5)
    expect(calls.map((call) => call.body)).toEqual([
      { limit: 2, offset: 4 },
      { limit: 2, search_after: "a" },
      { limit: 2, search_after: "b" },
    ])

    calls.length = 0
    // Fail instead of looping when the guard is missing: a 400 is never retried.
    mockFetch(() =>
      calls.length > 3
        ? apiError(400, "test.unbounded", "searchAll kept following a repeated cursor")
        : Response.json({ people: [PERSON], metadata: { search_after: "same" } })
    )
    let count = 0
    for await (const _person of client.people.searchAll({ limit: 1 })) count += 1
    expect(count).toBe(2)
  })

  test("looks up one person or company and requires an identifier", async () => {
    mockFetch((call) =>
      call.url.pathname.endsWith("/people/lookup")
        ? Response.json({ people: [PERSON], metadata: { credits: 0.25 } })
        : Response.json({ companies: [], metadata: { credits: 0 } })
    )
    const client = await connect()

    const person = await client.people.lookup({
      person_name: "John Snow",
      company_domain: "example.com",
    })
    expect(person.people[0]?.id).toBe(PERSON.id)
    expect(await client.companies.lookup({ domain: "unknown.example" })).toEqual({
      companies: [],
      metadata: { credits: 0 },
    })

    await expect(client.people.lookup({ person_name: "John Snow" })).rejects.toThrow(
      "people lookup needs"
    )
    await expect(client.companies.lookup({})).rejects.toThrow("company lookup needs")
    expect(calls).toHaveLength(2)
  })

  test("rejects a response envelope the client cannot use", async () => {
    mockFetch(() => Response.json({ people: "none" }))
    const client = await connect()

    await expect(client.people.search()).rejects.toThrow(
      "FullEnrich people search returned a malformed response: people must be an array of objects."
    )
  })
})
