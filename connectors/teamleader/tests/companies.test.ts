import { describe, expect, test } from "bun:test"
import type { TeamleaderCompanyAddressInput } from "../src"
import { createTeamleaderClient } from "../src/client"

type IsExact<TActual, TExpected> = [TActual] extends [TExpected]
  ? [TExpected] extends [TActual]
    ? true
    : false
  : false

const companyAddressInputTypesAreExact: IsExact<
  TeamleaderCompanyAddressInput["type"],
  "primary" | "invoicing" | "delivery" | "visiting"
> = true
const genericCompanyAddressFieldIsForbidden: IsExact<
  TeamleaderCompanyAddressInput["address"]["address"],
  undefined
> = true

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

describe("Teamleader companies", () => {
  test("supports every documented company endpoint", async () => {
    expect(companyAddressInputTypesAreExact).toBe(true)
    expect(genericCompanyAddressFieldIsForbidden).toBe(true)

    const requests: CapturedRequest[] = []
    const client = createTeamleaderClient({
      accessToken: "test-token",
      fetch: mockFetch((input, init) => {
        requests.push({ input, init })
        const path = new URL(String(input)).pathname

        if (path === "/companies.list") {
          return Promise.resolve(jsonResponse({ data: [] }))
        }

        if (path === "/companies.info") {
          return Promise.resolve(jsonResponse({ data: { id: "company-1" } }))
        }

        if (path === "/companies.add") {
          return Promise.resolve(
            jsonResponse({ data: { type: "company", id: "company-1" } }, { status: 201 })
          )
        }

        return Promise.resolve(new Response(undefined, { status: 204 }))
      }),
    })

    const addRequest = {
      name: "Pied Piper",
      business_type_id: "business-type-1",
      vat_number: "BE0899623035",
      national_identification_number: "63326426",
      emails: [
        { type: "primary", email: "info@piedpiper.eu" },
        { type: "invoicing", email: "invoicing@piedpiper.eu" },
      ],
      telephones: [
        { type: "phone", number: "092980615" },
        { type: "fax", number: "092980616" },
      ],
      website: "https://piedpiper.com",
      addresses: [
        {
          type: "primary",
          address: {
            addressee: "Pied Piper",
            line_1: "Dok Noord 3A 101",
            postal_code: "9000",
            city: "Ghent",
            country: "BE",
            area_level_two_id: "area-1",
          },
        },
      ],
      iban: "BE12123412341234",
      bic: "BICBANK",
      language: "en",
      responsible_user_id: "user-1",
      remarks: "Met at expo",
      tags: ["prospect", "expo"],
      custom_fields: [{ id: "field-1", value: "external-reference" }],
      marketing_mails_consent: false,
      preferred_currency: "EUR",
    } as const
    const updateRequest = {
      id: "company-1",
      name: "Pied Piper Europe",
      business_type_id: null,
      vat_number: null,
      national_identification_number: null,
      emails: [{ type: "primary", email: "hello@piedpiper.eu" }],
      telephones: [{ type: "phone", number: "092980617" }],
      website: "https://piedpiper.eu",
      addresses: [],
      iban: null,
      bic: null,
      language: null,
      responsible_user_id: null,
      remarks: null,
      tags: [],
      custom_fields: [{ id: "field-1", value: "updated-reference" }],
      custom_fields_update_strategy: "partial",
      marketing_mails_consent: true,
      preferred_currency: null,
    } as const
    const tagRequest = { id: "company-1", tags: ["customer", "newsletter"] } as const
    const untagRequest = { id: "company-1", tags: ["prospect"] } as const
    const uploadLogoRequest = { id: "company-1", image: null } as const

    await client.companies.list({
      filter: {
        email: { type: "primary", email: "info@piedpiper.eu" },
        ids: ["company-1"],
        term: "Pied Piper",
        updated_since: "2016-02-04T16:44:33+00:00",
        tags: ["prospect"],
        vat_number: "BE0899623035",
        national_identification_number: "63326426",
        status: "active",
        marketing_mails_consent: false,
      },
      page: { size: 20, number: 1 },
      sort: [{ field: "name", order: "asc" }],
      includes: "custom_fields,price_list",
    })
    await client.companies.info({
      id: "company-1",
      includes: "related_companies,related_contacts",
    })
    const added = await client.companies.add(addRequest)
    await client.companies.update(updateRequest)
    await client.companies.delete({ id: "company-1" })
    await client.companies.tag(tagRequest)
    await client.companies.untag(untagRequest)
    await client.companies.uploadLogo(uploadLogoRequest)

    expect(added.data).toEqual({ type: "company", id: "company-1" })
    expect(requests.map((request) => new URL(String(request.input)).pathname)).toEqual([
      "/companies.list",
      "/companies.info",
      "/companies.add",
      "/companies.update",
      "/companies.delete",
      "/companies.tag",
      "/companies.untag",
      "/companies.uploadLogo",
    ])
    expect(requests.map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      {
        filter: {
          email: { type: "primary", email: "info@piedpiper.eu" },
          ids: ["company-1"],
          term: "Pied Piper",
          updated_since: "2016-02-04T16:44:33+00:00",
          tags: ["prospect"],
          vat_number: "BE0899623035",
          national_identification_number: "63326426",
          status: "active",
          marketing_mails_consent: false,
        },
        page: { size: 20, number: 1 },
        sort: [{ field: "name", order: "asc" }],
        includes: "custom_fields,price_list",
      },
      { id: "company-1", includes: "related_companies,related_contacts" },
      addRequest,
      updateRequest,
      { id: "company-1" },
      tagRequest,
      untagRequest,
      uploadLogoRequest,
    ])
  })
})
