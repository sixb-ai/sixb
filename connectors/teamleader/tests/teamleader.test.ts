import { describe, expect, test } from "bun:test"
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
