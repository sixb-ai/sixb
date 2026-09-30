import type { FullEnrichClient, FullEnrichConnectorOptions } from "../src"
import { fullenrich } from "../src"

export const API_KEY = "fe_test_key"

export interface Call {
  readonly url: URL
  readonly method: string
  readonly headers: Headers
  readonly body: unknown
}

const originalFetch = globalThis.fetch
export const calls: Call[] = []

/** Register with `afterEach` in each test file that mocks `fetch`. */
export function restoreFetch(): void {
  globalThis.fetch = originalFetch
  calls.length = 0
}

/** Replace `fetch` with a handler that records every request. */
export function mockFetch(handler: (call: Call) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
}

export function connect(
  options: Partial<FullEnrichConnectorOptions> = {},
  signal = new AbortController().signal
): Promise<FullEnrichClient> {
  return Promise.resolve(
    fullenrich({ apiKey: API_KEY, ...options }).connect({
      projectId: "test",
      connectorId: "fullenrich",
      signal,
    })
  )
}

export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status })
}

export const PERSON = {
  id: "746e4816-19c8-54d8-b558-65a5a52cc85c",
  full_name: "John Snow",
  first_name: "John",
  last_name: "Snow",
  headline: "Head of Sales Operations at Example Inc",
  description: "Sales operations leader.",
  location: { country: "United States", country_code: "US", city: "San Francisco" },
  social_profiles: {
    professional_network: { url: "https://www.linkedin.com/in/john-snow", handle: "john-snow" },
  },
  skills: ["Sales Operations", "CRM Management"],
  languages: [{ language: "English", proficiency: "NATIVE_OR_BILINGUAL" }],
  educations: [{ school_name: "Stanford University", degree: "BSc" }],
  employment: {
    current: {
      title: "Head of Sales Operations",
      seniority: "Head",
      is_current: true,
      start_at: "2022-03-15T00:00:00Z",
      company: {
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        name: "Example Inc",
        domain: "example.com",
        headcount: 250,
        industry: { main_industry: "Software Development" },
      },
    },
    all: [
      {
        title: "Head of Sales Operations",
        is_current: true,
        company: { name: "Example Inc", domain: "example.com" },
      },
      {
        title: "Sales Manager",
        is_current: false,
        end_at: "2022-03-01T00:00:00Z",
        company: { name: "Previous Corp", domain: "previouscorp.com" },
      },
    ],
  },
}

export const COMPANY = {
  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  name: "Example Inc",
  domain: "example.com",
  website: "https://www.example.com",
  description: "Leading example company",
  year_founded: 2010,
  headcount: 250,
  headcount_range: "201-500",
  company_type: "Privately Held",
  specialties: ["Examples"],
  technologies: [{ name: "Notion", logo_url: "https://logo.example/notion.png" }],
  locations: {
    headquarters: { city: "San Francisco", region: "California", country: "United States" },
    offices: [{ line1: "456 Broadway", line2: "New York, NY 10013, US" }],
  },
  industry: { main_industry: "Software Development" },
  social_profiles: { professional_network: { url: "https://www.linkedin.com/company/example" } },
}

export const ENRICHMENT = {
  id: "2db5ea61-1752-42cf-8ea1-ab1da060cd0a",
  name: "Sales Operations in London",
  status: "FINISHED",
  cost: { credits: 14 },
  data: [
    {
      input: {
        first_name: "John",
        last_name: "Snow",
        company_domain: "example.com",
        professional_network_url: "https://www.linkedin.com/in/john-snow",
      },
      custom: { user_id: "12584" },
      contact_info: {
        most_probable_work_email: { email: "john.snow@example.com", status: "DELIVERABLE" },
        most_probable_personal_email: null,
        most_probable_phone: {
          number: "+1 555-123-4567",
          region: "US",
          line_type: "MOBILE",
          line_status: "ACTIVE",
          ownership_match: "CONFIRMED",
          ownership_match_confidence: 90,
          connect_rate: "HIGHEST",
        },
        work_emails: [{ email: "john.snow@example.com", status: "DELIVERABLE" }],
        personal_emails: [],
        phones: [{ number: "+1 555-123-4567", region: "US", line_type: "MOBILE" }],
      },
      profile: PERSON,
    },
  ],
}
