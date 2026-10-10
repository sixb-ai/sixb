import { describe, expect, test } from "bun:test"
import {
  type AgentToolArtifacts,
  type AgentToolDefinition,
  AgentToolPublicError,
  type AgentToolRunContext,
  defineConnector,
  noopLogger,
} from "@sixb/core"
import type { FullEnrichClient, FullEnrichConnector } from "../src"
import { FullEnrichApiError } from "../src"
import {
  fullEnrichCreditBalance,
  fullEnrichGetContactEnrichment,
  fullEnrichGetReverseEmailLookup,
  fullEnrichLookupCompany,
  fullEnrichLookupPerson,
  fullEnrichSearchCompanies,
  fullEnrichSearchPeople,
  fullEnrichStartContactEnrichment,
  fullEnrichStartReverseEmailLookup,
} from "../src/agent-tools"
import { COMPANY, ENRICHMENT, PERSON } from "./helpers"

type ClientStub = { [K in keyof FullEnrichClient]?: Partial<FullEnrichClient[K]> }

const unusedArtifacts: AgentToolArtifacts = {
  async put() {
    throw new Error("Artifacts are unused by FullEnrich agent tools.")
  },
}

const definition = defineConnector("fullenrich", {
  type: "fullenrich",
  connect: () => {
    throw new Error("The harness resolves the client directly.")
  },
} satisfies FullEnrichConnector)

/** Run a tool the way the agent worker does, against a stubbed connected client. */
function run(
  tool: AgentToolDefinition,
  input: Record<string, unknown>,
  client: ClientStub,
  signal = new AbortController().signal
) {
  const connector = (async (requested: unknown) => {
    expect(requested).toBe(definition)
    return client
  }) as AgentToolRunContext["sixb"]["connector"]
  return Promise.resolve(
    tool.handler({
      input,
      toolCallId: "call-1",
      signal,
      run: { kind: "conversation", id: "run-1", threadId: "thread-1" },
      sixb: { connector } as AgentToolRunContext["sixb"],
      logger: noopLogger,
      artifacts: unusedArtifacts,
    })
  )
}

describe("FullEnrich search tools", () => {
  test("search_people passes filters verbatim, bounds the page, and summarizes profiles", async () => {
    let request: unknown
    const tool = fullEnrichSearchPeople(definition)
    const filters = {
      current_position_titles: [{ value: "Head of Sales" }],
      current_position_seniority_level: [{ value: "VP" }, { value: "Director" }],
      person_locations: [{ value: "France", exclude: true }],
    }

    const output = await run(
      tool,
      { filters, page: {} },
      {
        people: {
          async search(received) {
            request = received
            return {
              people: [PERSON],
              metadata: { total: 42, credits: 0.25, search_after: "next" },
            }
          },
        },
      }
    )

    expect(tool.name).toBe("search_people")
    expect(request).toEqual({ ...filters, limit: 10 })
    expect(output).toEqual({
      people: [
        {
          id: PERSON.id,
          full_name: "John Snow",
          headline: "Head of Sales Operations at Example Inc",
          location: "San Francisco, United States",
          linkedin_url: "https://www.linkedin.com/in/john-snow",
          current_position: {
            title: "Head of Sales Operations",
            seniority: "Head",
            company: {
              id: PERSON.employment.current.company.id,
              name: "Example Inc",
              domain: "example.com",
              industry: "Software Development",
              headcount: 250,
            },
            is_current: true,
            start_at: "2022-03-15T00:00:00Z",
          },
        },
      ],
      total: 42,
      credits: 0.25,
    })
  })

  // Live FullEnrich returns a cursor after the last result. Guard proof: drop `!exhausted` in
  // pageOutput; next_cursor reappears.
  test("search tools omit next_cursor once the first page reaches the reported total", async () => {
    const output = await run(
      fullEnrichSearchCompanies(definition),
      { filters: { domains: [{ value: "example.com", exact_match: true }] }, page: { limit: 1 } },
      {
        companies: {
          search: async () => ({
            companies: [COMPANY],
            metadata: { total: 1, credits: 0, offset: 0, search_after: "past-the-end" },
          }),
        },
      }
    )

    expect(output).not.toHaveProperty("next_cursor")
    expect(output).toMatchObject({ total: 1, credits: 0 })
  })

  test("search_companies returns next_cursor only for a full page and enforces maxResults", async () => {
    const requests: unknown[] = []
    const tool = fullEnrichSearchCompanies(definition, { maxResults: 2 })
    const client: ClientStub = {
      companies: {
        async search(received) {
          requests.push(received)
          return { companies: [COMPANY, COMPANY], metadata: { search_after: "next" } }
        },
      },
    }

    const output = (await run(
      tool,
      { filters: { industries: [{ value: "Software Development" }] }, page: { cursor: " prev " } },
      client
    )) as { companies: unknown[]; next_cursor?: string }

    expect(requests).toEqual([
      { industries: [{ value: "Software Development" }], limit: 2, search_after: "prev" },
    ])
    expect(output.companies).toHaveLength(2)
    expect(output.companies[0]).toMatchObject({
      name: "Example Inc",
      headquarters: "San Francisco, California, United States",
      industry: "Software Development",
    })
    expect(output.next_cursor).toBe("next")

    const error = await run(tool, { filters: {}, page: { limit: 3 } }, client).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(AgentToolPublicError)
    expect((error as Error).message).toContain("page.limit must be an integer from 1 to 2")
    expect(requests).toHaveLength(1)
  })

  test("lookup tools require an identifier and return full detail or null", async () => {
    const people: unknown[] = []
    const client: ClientStub = {
      people: {
        async lookup(request) {
          people.push(request)
          return { people: [PERSON], metadata: { credits: 0.25 } }
        },
      },
      companies: {
        async lookup() {
          return { companies: [], metadata: { credits: 0 } }
        },
      },
    }

    await expect(
      run(fullEnrichLookupPerson(definition), { identifiers: { person_name: "John" } }, client)
    ).rejects.toThrow("lookup_person needs a LinkedIn profile URL or ID")

    const person = (await run(
      fullEnrichLookupPerson(definition),
      {
        identifiers: {
          person_name: " John Snow ",
          company_domain: "example.com",
          company_professional_network_url: "",
        },
      },
      client
    )) as { person: Record<string, unknown>; credits: number }
    expect(people).toEqual([{ person_name: "John Snow", company_domain: "example.com" }])
    expect(person.credits).toBe(0.25)
    expect(person.person).toMatchObject({
      full_name: "John Snow",
      description: "Sales operations leader.",
      skills: ["Sales Operations", "CRM Management"],
      languages: ["English (NATIVE_OR_BILINGUAL)"],
      educations: [{ school_name: "Stanford University", degree: "BSc" }],
    })
    expect(person.person.experience).toEqual([
      {
        title: "Head of Sales Operations",
        company: { name: "Example Inc", domain: "example.com" },
        is_current: true,
      },
      {
        title: "Sales Manager",
        company: { name: "Previous Corp", domain: "previouscorp.com" },
        is_current: false,
        end_at: "2022-03-01T00:00:00Z",
      },
    ])

    expect(
      await run(
        fullEnrichLookupCompany(definition),
        { identifiers: { domain: "none.example" } },
        client
      )
    ).toEqual({ company: null, credits: 0 })
    await expect(
      run(fullEnrichLookupCompany(definition), { identifiers: {} }, client)
    ).rejects.toThrow("lookup_company needs a domain")
  })
})

describe("FullEnrich enrichment tools", () => {
  test("start_contact_enrichment restricts fields and contacts and routes results to the host webhook", async () => {
    let started: { request: unknown; options: unknown } | undefined
    const tool = fullEnrichStartContactEnrichment(definition, {
      maxContacts: 2,
      allowedFields: ["contact.work_emails"],
      webhookUrl: "https://api.example/api/webhooks/fullenrich/enrichments",
    })
    const client: ClientStub = {
      enrichments: {
        async start(request, options) {
          started = { request, options: { silentFail: options?.silentFail } }
          return { enrichment_id: "enrichment-1" }
        },
      },
    }

    expect(tool.input.enrich_fields).toEqual({
      type: "array",
      items: { type: "enum", valueType: "string", values: ["contact.work_emails"] },
    })
    const output = await run(
      tool,
      {
        contacts: [
          { first_name: " John ", last_name: "Snow", domain: "example.com" },
          { linkedin_url: "https://www.linkedin.com/in/demoge/" },
        ],
        enrich_fields: ["contact.work_emails", "contact.work_emails"],
      },
      client
    )

    expect(output).toEqual({
      enrichment_id: "enrichment-1",
      contacts: 2,
      enrich_fields: ["contact.work_emails"],
    })
    expect(started).toEqual({
      request: {
        name: "Enrichment: John Snow +1 more",
        webhook_url: "https://api.example/api/webhooks/fullenrich/enrichments",
        data: [
          {
            first_name: "John",
            last_name: "Snow",
            domain: "example.com",
            enrich_fields: ["contact.work_emails"],
          },
          {
            linkedin_url: "https://www.linkedin.com/in/demoge/",
            enrich_fields: ["contact.work_emails"],
          },
        ],
      },
      options: { silentFail: undefined },
    })

    await expect(
      run(
        tool,
        {
          contacts: [{ first_name: "John", last_name: "Snow" }],
          enrich_fields: ["contact.work_emails"],
        },
        client
      )
    ).rejects.toThrow("contacts[0] needs a linkedin_url")
    await expect(
      run(tool, { contacts: [{}, {}, {}], enrich_fields: ["contact.work_emails"] }, client)
    ).rejects.toThrow("contacts must contain from 1 to 2 entries")
    expect(() => fullEnrichStartContactEnrichment(definition, { allowedFields: [] })).toThrow(
      "allowedFields must list one or more"
    )
  })

  // Guard proof: remove the `.in_progress` branch in readJob, or the `isReady` gate on
  // `contacts`; the matching not-ready expectation fails.
  test("get_contact_enrichment reports a running job as not ready and projects results", async () => {
    const tool = fullEnrichGetContactEnrichment(definition)
    let state: "documented-400" | "live-200" | "finished" = "documented-400"
    const client: ClientStub = {
      enrichments: {
        async get(id) {
          if (state === "documented-400") {
            throw new FullEnrichApiError("not ready", {
              status: 400,
              code: "error.enrichment.in_progress",
            })
          }
          // What the live API answers while running: 200, IN_PROGRESS, and no data.
          if (state === "live-200") {
            return { id, name: ENRICHMENT.name, status: "IN_PROGRESS", cost: { credits: 0 } }
          }
          return { ...ENRICHMENT, id } as never
        },
      },
    }

    expect(await run(tool, { enrichment_id: ENRICHMENT.id }, client)).toEqual({
      enrichment_id: ENRICHMENT.id,
      ready: false,
      status: "IN_PROGRESS",
    })
    state = "live-200"
    expect(await run(tool, { enrichment_id: ENRICHMENT.id }, client)).toEqual({
      enrichment_id: ENRICHMENT.id,
      ready: false,
      status: "IN_PROGRESS",
      credits: 0,
    })

    state = "finished"
    const output = (await run(tool, { enrichment_id: ENRICHMENT.id }, client)) as {
      contacts: Record<string, unknown>[]
    }
    expect(output).toMatchObject({ ready: true, status: "FINISHED", credits: 14 })
    expect(output.contacts[0]).toMatchObject({
      input: { first_name: "John", company_domain: "example.com" },
      most_probable_work_email: { email: "john.snow@example.com", status: "DELIVERABLE" },
      most_probable_phone: { number: "+1 555-123-4567", ownership_match_confidence: 90 },
      phones: [{ number: "+1 555-123-4567", region: "US", line_type: "MOBILE" }],
      profile: { full_name: "John Snow" },
    })
    expect(output.contacts[0]).not.toHaveProperty("most_probable_personal_email")
    expect(output.contacts[0]).not.toHaveProperty("personal_emails")
    expect(output.contacts[0]).not.toHaveProperty("custom")
  })

  test("reverse email tools start a lookup and read identified people", async () => {
    let started: unknown
    const client: ClientStub = {
      reverseEmailLookups: {
        async start(request) {
          started = request
          return { enrichment_id: "lookup-1" }
        },
        async get(id) {
          return {
            id,
            status: "FINISHED",
            cost: { credits: 1 },
            data: [
              { input: { email: "john.snow@example.com" }, profile: PERSON },
              { input: { email: "nobody@example.com" } },
            ],
          } as never
        },
      },
    }

    expect(
      await run(
        fullEnrichStartReverseEmailLookup(definition),
        { emails: [" john.snow@example.com "] },
        client
      )
    ).toEqual({ lookup_id: "lookup-1", emails: 1 })
    expect(started).toEqual({
      name: "Reverse email lookup: john.snow@example.com",
      data: [{ email: "john.snow@example.com" }],
    })
    await expect(
      run(fullEnrichStartReverseEmailLookup(definition), { emails: ["not-an-email"] }, client)
    ).rejects.toThrow("emails[0] must be an email address")

    const output = (await run(
      fullEnrichGetReverseEmailLookup(definition),
      { lookup_id: "lookup-1" },
      client
    )) as { results: Record<string, unknown>[] }
    expect(output).toMatchObject({ lookup_id: "lookup-1", ready: true, credits: 1 })
    expect(output.results[0]).toMatchObject({
      email: "john.snow@example.com",
      person: { full_name: "John Snow" },
    })
    expect(output.results[1]).toEqual({ email: "nobody@example.com", person: null })
  })
})

describe("FullEnrich tool bounds", () => {
  test("get_enrichment_credits returns the balance", async () => {
    expect(
      await run(
        fullEnrichCreditBalance(definition),
        {},
        {
          account: { credits: async () => ({ balance: 4200 }) },
        }
      )
    ).toEqual({ balance: 4200 })
  })

  test("times out a slow provider with a public error and keeps run cancellation raw", async () => {
    const pending: ClientStub = {
      account: { credits: () => new Promise(() => {}) },
    }

    const error = await run(
      fullEnrichCreditBalance(definition, { timeoutMs: 5 }),
      {},
      pending
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AgentToolPublicError)
    expect((error as Error).message).toBe(
      "[SixbFullEnrich] get_enrichment_credits timed out after 5ms."
    )

    const controller = new AbortController()
    const reason = new Error("run canceled")
    const running = run(fullEnrichCreditBalance(definition), {}, pending, controller.signal)
    controller.abort(reason)
    await expect(running).rejects.toBe(reason)
  })

  test("rejects invalid host options when the tool is defined", () => {
    expect(() => fullEnrichSearchPeople(definition, { maxResults: 101 })).toThrow(
      "maxResults must be an integer from 1 to 100"
    )
    expect(() =>
      fullEnrichStartReverseEmailLookup(definition, { webhookUrl: "ftp://example.com" })
    ).toThrow("webhookUrl must be an absolute HTTP(S) URL")
    expect(() => fullEnrichCreditBalance(definition, { timeoutMs: 0 })).toThrow(
      "timeoutMs must be an integer"
    )
  })
})
