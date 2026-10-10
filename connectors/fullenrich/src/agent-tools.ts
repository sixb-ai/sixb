import type {
  AgentToolDefinition,
  ConnectorDefinition,
  ConnectorRuntime,
  JsonValue,
} from "@sixb/core"
import { AgentToolPublicError, defineAgentTool, stringEnum } from "@sixb/core"
import {
  companyDetail,
  companySummary,
  enrichmentRecord,
  personDetail,
  personSummary,
  reverseEmailRecord,
} from "./agent-tool-output"
import { FullEnrichApiError } from "./errors"
import { ENRICH_FIELDS } from "./resources/enrichments"
import { waitForSignal } from "./signals"
import type {
  FullEnrichClient,
  FullEnrichConnector,
  FullEnrichContactInput,
  FullEnrichEnrichField,
  FullEnrichJobStatus,
  FullEnrichSearchMetadata,
} from "./types"
import { MAX_BATCH_SIZE, MAX_SEARCH_LIMIT } from "./validation"

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_PAGE_SIZE = 10
const DEFAULT_MAX_RESULTS = 25
const DEFAULT_MAX_CONTACTS = 10
const MAX_INPUT_CHARACTERS = 500

type FullEnrichConnectorDefinition = ConnectorDefinition<string, FullEnrichConnector>

// ── Input schemas ───────────────────────────────────────────
// Field names are FullEnrich's own; "professional network" is LinkedIn. JSON schema carries no
// field descriptions, so each tool description explains what the model needs to fill them in.

const textFilter = {
  type: "array",
  items: {
    type: "object",
    properties: {
      value: { schema: "string", required: true },
      exclude: { schema: "boolean" },
      exact_match: { schema: "boolean" },
    },
  },
} as const

const integerFilter = {
  type: "array",
  items: {
    type: "object",
    properties: {
      value: { schema: "integer", required: true },
      exclude: { schema: "boolean" },
      exact_match: { schema: "boolean" },
    },
  },
} as const

const rangeFilter = {
  type: "array",
  items: {
    type: "object",
    properties: {
      min: { schema: "integer" },
      max: { schema: "integer" },
      exclude: { schema: "boolean" },
    },
  },
} as const

/** A filter over FullEnrich's documented accepted values, where fuzzy matching has no meaning. */
function valueFilter<const V extends readonly string[]>(values: V) {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { schema: stringEnum(values), required: true },
        exclude: { schema: "boolean" },
      },
    },
  } as const
}

const SENIORITIES = [
  "Owner",
  "Founder",
  "C-level",
  "Partner",
  "VP",
  "Head",
  "Director",
  "Manager",
  "Senior",
] as const

const COMPANY_TYPES = [
  "Partnership",
  "Nonprofit",
  "Educational",
  "Privately Held",
  "Public Company",
  "Self-Owned",
  "Self-Employed",
  "Government Agency",
] as const

const JOB_FUNCTIONS = [
  "Administrative",
  "Agriculture & Environment",
  "Construction & Trades",
  "Consulting & Advisory",
  "Customer Service",
  "Design",
  "Education",
  "Energy & Utilities",
  "Entertainment & Gaming",
  "Executive & Leadership",
  "Finance",
  "Hospitality & Tourism",
  "Human Resources",
  "Legal",
  "Marketing",
  "Media & Communications",
  "Medical & Health",
  "Non-Profit & Government",
  "Not Employed",
  "Operations",
  "Personal & Home Services",
  "Product",
  "Project & Program Management",
  "Public Safety & Security",
  "Research & Science",
  "Retail & Consumer",
  "Sales",
  "Software",
  "Traditional Engineering",
  "Transportation & Logistics",
] as const

const page = {
  type: "object",
  properties: {
    limit: { schema: "integer" },
    cursor: { schema: "string" },
  },
} as const

const PEOPLE_SEARCH_INPUT = {
  filters: {
    type: "object",
    properties: {
      person_names: { schema: textFilter },
      person_locations: { schema: textFilter },
      person_skills: { schema: textFilter },
      person_languages: { schema: textFilter },
      person_universities: { schema: textFilter },
      person_professional_network_urls: { schema: textFilter },
      person_professional_network_ids: { schema: integerFilter },
      person_ids: { schema: textFilter },
      current_position_titles: { schema: textFilter },
      current_position_seniority_level: { schema: valueFilter(SENIORITIES) },
      current_position_job_functions: { schema: valueFilter(JOB_FUNCTIONS) },
      current_position_sub_functions: { schema: textFilter },
      current_position_years_in: { schema: rangeFilter },
      past_position_titles: { schema: textFilter },
      current_company_names: { schema: textFilter },
      current_company_domains: { schema: textFilter },
      current_company_industries: { schema: textFilter },
      current_company_specialties: { schema: textFilter },
      current_company_technologies: { schema: textFilter },
      current_company_types: { schema: valueFilter(COMPANY_TYPES) },
      current_company_headquarters: { schema: textFilter },
      current_company_headcounts: { schema: rangeFilter },
      current_company_founded_years: { schema: rangeFilter },
      current_company_years_at: { schema: rangeFilter },
      current_company_days_since_last_job_change: { schema: rangeFilter },
      current_company_professional_network_urls: { schema: textFilter },
      current_company_professional_network_ids: { schema: integerFilter },
      current_company_ids: { schema: textFilter },
      past_company_names: { schema: textFilter },
      past_company_domains: { schema: textFilter },
    },
  },
  page,
} as const

const COMPANY_SEARCH_INPUT = {
  filters: {
    type: "object",
    properties: {
      names: { schema: textFilter },
      domains: { schema: textFilter },
      keywords: { schema: textFilter },
      industries: { schema: textFilter },
      specialties: { schema: textFilter },
      technologies: { schema: textFilter },
      types: { schema: valueFilter(COMPANY_TYPES) },
      headquarters_locations: { schema: textFilter },
      headcounts: { schema: rangeFilter },
      founded_years: { schema: rangeFilter },
      professional_network_urls: { schema: textFilter },
      professional_network_ids: { schema: integerFilter },
      company_ids: { schema: textFilter },
    },
  },
  page,
} as const

const PERSON_LOOKUP_INPUT = {
  identifiers: {
    type: "object",
    properties: {
      person_professional_network_url: { schema: "string" },
      person_professional_network_id: { schema: "integer" },
      person_name: { schema: "string" },
      company_domain: { schema: "string" },
      company_professional_network_url: { schema: "string" },
      company_professional_network_id: { schema: "integer" },
    },
  },
} as const

const COMPANY_LOOKUP_INPUT = {
  identifiers: {
    type: "object",
    properties: {
      domain: { schema: "string" },
      professional_network_url: { schema: "string" },
      professional_network_id: { schema: "integer" },
    },
  },
} as const

function contactEnrichmentInput<const F extends readonly FullEnrichEnrichField[]>(fields: F) {
  return {
    contacts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          first_name: { schema: "string" },
          last_name: { schema: "string" },
          domain: { schema: "string" },
          company_name: { schema: "string" },
          linkedin_url: { schema: "string" },
        },
      },
    },
    enrich_fields: { type: "array", items: stringEnum(fields) },
  } as const
}

type ContactEnrichmentInput = ReturnType<
  typeof contactEnrichmentInput<readonly FullEnrichEnrichField[]>
>

const ENRICHMENT_ID_INPUT = { enrichment_id: "string" } as const
const REVERSE_EMAIL_LOOKUP_INPUT = { emails: { type: "array", items: "string" } } as const
const LOOKUP_ID_INPUT = { lookup_id: "string" } as const

// ── Public types ────────────────────────────────────────────

export interface FullEnrichToolOptions {
  /** Overall connector resolution and provider-request timeout. Defaults to 20 seconds. */
  readonly timeoutMs?: number
}

export interface FullEnrichSearchToolOptions extends FullEnrichToolOptions {
  /** Most results one call may return, each costing credits. Defaults to 25; at most 100. */
  readonly maxResults?: number
}

export interface FullEnrichStartJobToolOptions extends FullEnrichToolOptions {
  /** Where FullEnrich posts the finished job, such as this connector's result webhook. */
  readonly webhookUrl?: string
  /** Where FullEnrich posts each contact as soon as it is processed. */
  readonly contactFinishedWebhookUrl?: string
  /** Skip invalid entries instead of rejecting the batch. Defaults to false. */
  readonly silentFail?: boolean
}

export interface FullEnrichStartContactEnrichmentOptions extends FullEnrichStartJobToolOptions {
  /** Most contacts one call may submit. Defaults to 10; at most 100. */
  readonly maxContacts?: number
  /** Data the model may request. Defaults to work emails, personal emails, and phones. */
  readonly allowedFields?: readonly FullEnrichEnrichField[]
}

export interface FullEnrichStartReverseEmailLookupOptions extends FullEnrichStartJobToolOptions {
  /** Most emails one call may submit. Defaults to 10; at most 100. */
  readonly maxEmails?: number
}

export type FullEnrichSearchPeopleTool = AgentToolDefinition<
  "search_people",
  typeof PEOPLE_SEARCH_INPUT
>
export type FullEnrichSearchCompaniesTool = AgentToolDefinition<
  "search_companies",
  typeof COMPANY_SEARCH_INPUT
>
export type FullEnrichLookupPersonTool = AgentToolDefinition<
  "lookup_person",
  typeof PERSON_LOOKUP_INPUT
>
export type FullEnrichLookupCompanyTool = AgentToolDefinition<
  "lookup_company",
  typeof COMPANY_LOOKUP_INPUT
>
export type FullEnrichStartContactEnrichmentTool = AgentToolDefinition<
  "start_contact_enrichment",
  ContactEnrichmentInput
>
export type FullEnrichGetContactEnrichmentTool = AgentToolDefinition<
  "get_contact_enrichment",
  typeof ENRICHMENT_ID_INPUT
>
export type FullEnrichStartReverseEmailLookupTool = AgentToolDefinition<
  "start_reverse_email_lookup",
  typeof REVERSE_EMAIL_LOOKUP_INPUT
>
export type FullEnrichGetReverseEmailLookupTool = AgentToolDefinition<
  "get_reverse_email_lookup",
  typeof LOOKUP_ID_INPUT
>
export type FullEnrichCreditBalanceTool = AgentToolDefinition<
  "get_enrichment_credits",
  Record<never, never>
>

const FILTER_SYNTAX =
  "Each filter is a list of {value, exclude?, exact_match?}; range filters take {min?, max?, exclude?}. " +
  "Values in one filter are ORed and different filters are ANDed. Without exact_match, minor " +
  "wording differences still match. Locations accept a continent, a country in English, or a " +
  "region or city in the local language. page.limit sets the page size; pass the returned next_cursor as page.cursor for the " +
  "next page. Each newly returned result costs 0.25 credits."

// ── Search and lookup ───────────────────────────────────────

/** Create a bounded `search_people` tool over FullEnrich's people database. */
export function fullEnrichSearchPeople(
  connectorDefinition: FullEnrichConnectorDefinition,
  options: FullEnrichSearchToolOptions = {}
): FullEnrichSearchPeopleTool {
  const timeoutMs = resolveTimeout(options)
  const maxResults = resolveLimit(
    options.maxResults,
    DEFAULT_MAX_RESULTS,
    MAX_SEARCH_LIMIT,
    "maxResults"
  )

  return defineAgentTool("search_people")
    .description(
      "Find B2B people by name, title, seniority, job function, location, skills, and current " +
        "or past company. Returns summarized profiles without emails or phones; use " +
        "lookup_person for a full profile and start_contact_enrichment for contact details. " +
        FILTER_SYNTAX
    )
    .input(PEOPLE_SEARCH_INPUT)
    .run(async ({ input, sixb: { connector }, signal }) => {
      const limit = pageLimit(input.page.limit, maxResults, "search_people")
      const cursor = pageCursor(input.page.cursor, "search_people")
      const response = await callFullEnrich(
        { connectorDefinition, connector, signal, timeoutMs, toolName: "search_people" },
        (client, requestSignal) =>
          client.people.search(
            { ...input.filters, limit, ...(cursor ? { search_after: cursor } : {}) },
            { signal: requestSignal }
          )
      )
      const people = response.people.slice(0, limit)
      return {
        people: people.map(personSummary),
        ...pageOutput(response.metadata, people.length, limit),
      }
    })
}

/** Create a bounded `search_companies` tool over FullEnrich's company database. */
export function fullEnrichSearchCompanies(
  connectorDefinition: FullEnrichConnectorDefinition,
  options: FullEnrichSearchToolOptions = {}
): FullEnrichSearchCompaniesTool {
  const timeoutMs = resolveTimeout(options)
  const maxResults = resolveLimit(
    options.maxResults,
    DEFAULT_MAX_RESULTS,
    MAX_SEARCH_LIMIT,
    "maxResults"
  )

  return defineAgentTool("search_companies")
    .description(
      "Find companies by name, domain, description keywords, industry, specialties, " +
        "technologies, type, headquarters location, headcount, and founding year. Returns " +
        "summarized companies; use lookup_company for full detail. " +
        FILTER_SYNTAX
    )
    .input(COMPANY_SEARCH_INPUT)
    .run(async ({ input, sixb: { connector }, signal }) => {
      const limit = pageLimit(input.page.limit, maxResults, "search_companies")
      const cursor = pageCursor(input.page.cursor, "search_companies")
      const response = await callFullEnrich(
        { connectorDefinition, connector, signal, timeoutMs, toolName: "search_companies" },
        (client, requestSignal) =>
          client.companies.search(
            { ...input.filters, limit, ...(cursor ? { search_after: cursor } : {}) },
            { signal: requestSignal }
          )
      )
      const companies = response.companies.slice(0, limit)
      return {
        companies: companies.map(companySummary),
        ...pageOutput(response.metadata, companies.length, limit),
      }
    })
}

/** Create a `lookup_person` tool that returns one full professional profile. */
export function fullEnrichLookupPerson(
  connectorDefinition: FullEnrichConnectorDefinition,
  options: FullEnrichToolOptions = {}
): FullEnrichLookupPersonTool {
  const timeoutMs = resolveTimeout(options)

  return defineAgentTool("lookup_person")
    .description(
      "Look up one person's full professional profile (experience, education, skills) without " +
        "emails or phones. Identify them by person_professional_network_url (LinkedIn profile " +
        "URL) or _id, or by person_name together with company_domain, " +
        "company_professional_network_url, or company_professional_network_id. Returns " +
        "person: null when nothing matches. Costs 0.25 credits unless already retrieved."
    )
    .input(PERSON_LOOKUP_INPUT)
    .run(async ({ input, sixb: { connector }, signal }) => {
      const identifiers = trimStrings(input.identifiers, "lookup_person")
      const byProfile =
        identifiers.person_professional_network_url !== undefined ||
        identifiers.person_professional_network_id !== undefined
      const byCompany =
        identifiers.company_domain !== undefined ||
        identifiers.company_professional_network_url !== undefined ||
        identifiers.company_professional_network_id !== undefined
      if (!byProfile && !(identifiers.person_name !== undefined && byCompany)) {
        throw new AgentToolPublicError(
          "[SixbFullEnrich] lookup_person needs a LinkedIn profile URL or ID, or person_name with a company identifier."
        )
      }
      const response = await callFullEnrich(
        { connectorDefinition, connector, signal, timeoutMs, toolName: "lookup_person" },
        (client, requestSignal) => client.people.lookup(identifiers, { signal: requestSignal })
      )
      const person = response.people[0]
      return {
        person: person ? personDetail(person) : null,
        ...creditsOutput(response.metadata?.credits),
      }
    })
}

/** Create a `lookup_company` tool that returns one full company profile. */
export function fullEnrichLookupCompany(
  connectorDefinition: FullEnrichConnectorDefinition,
  options: FullEnrichToolOptions = {}
): FullEnrichLookupCompanyTool {
  const timeoutMs = resolveTimeout(options)

  return defineAgentTool("lookup_company")
    .description(
      "Look up one company's full profile by domain, professional_network_url (LinkedIn " +
        "company URL), or professional_network_id. Returns company: null when nothing matches. " +
        "Costs 0.25 credits unless already retrieved."
    )
    .input(COMPANY_LOOKUP_INPUT)
    .run(async ({ input, sixb: { connector }, signal }) => {
      const identifiers = trimStrings(input.identifiers, "lookup_company")
      if (
        identifiers.domain === undefined &&
        identifiers.professional_network_url === undefined &&
        identifiers.professional_network_id === undefined
      ) {
        throw new AgentToolPublicError(
          "[SixbFullEnrich] lookup_company needs a domain, professional_network_url, or professional_network_id."
        )
      }
      const response = await callFullEnrich(
        { connectorDefinition, connector, signal, timeoutMs, toolName: "lookup_company" },
        (client, requestSignal) => client.companies.lookup(identifiers, { signal: requestSignal })
      )
      const company = response.companies[0]
      return {
        company: company ? companyDetail(company) : null,
        ...creditsOutput(response.metadata?.credits),
      }
    })
}

// ── Contact enrichment ──────────────────────────────────────

/** Create a `start_contact_enrichment` tool that finds emails and phones asynchronously. */
export function fullEnrichStartContactEnrichment(
  connectorDefinition: FullEnrichConnectorDefinition,
  options: FullEnrichStartContactEnrichmentOptions = {}
): FullEnrichStartContactEnrichmentTool {
  const timeoutMs = resolveTimeout(options)
  const maxContacts = resolveLimit(
    options.maxContacts,
    DEFAULT_MAX_CONTACTS,
    MAX_BATCH_SIZE,
    "maxContacts"
  )
  const allowedFields = resolveAllowedFields(options.allowedFields)
  const webhooks = resolveWebhooks(options)

  return defineAgentTool("start_contact_enrichment")
    .description(
      `Start finding contact details for up to ${maxContacts} people. Give each contact a ` +
        "linkedin_url, or first_name and last_name with a company domain or company_name; a " +
        "LinkedIn URL gives the best results. enrich_fields chooses the data: " +
        `${allowedFields.join(", ")}. Credits are charged only when found: 1 per work email, ` +
        "3 per personal email, 10 per phone. Enrichment takes 30 to 90 seconds; this returns an " +
        "enrichment_id to pass to get_contact_enrichment later."
    )
    .input(contactEnrichmentInput(allowedFields))
    .run(async ({ input, sixb: { connector }, signal }) => {
      const enrichFields = [...new Set(input.enrich_fields)]
      if (enrichFields.length === 0) {
        throw new AgentToolPublicError(
          "[SixbFullEnrich] start_contact_enrichment needs at least one enrich_fields value."
        )
      }
      assertCount(input.contacts.length, maxContacts, "contacts", "start_contact_enrichment")
      const contacts = input.contacts.map((contact, index): FullEnrichContactInput => {
        const trimmed = trimStrings(contact, "start_contact_enrichment")
        const identified =
          trimmed.linkedin_url !== undefined ||
          (trimmed.first_name !== undefined &&
            trimmed.last_name !== undefined &&
            (trimmed.domain !== undefined || trimmed.company_name !== undefined))
        if (!identified && !options.silentFail) {
          throw new AgentToolPublicError(
            `[SixbFullEnrich] start_contact_enrichment contacts[${index}] needs a linkedin_url, or first_name and last_name with a domain or company_name.`
          )
        }
        return { ...trimmed, enrich_fields: enrichFields }
      })

      const started = await callFullEnrich(
        { connectorDefinition, connector, signal, timeoutMs, toolName: "start_contact_enrichment" },
        (client, requestSignal) =>
          client.enrichments.start(
            {
              name: jobName("Enrichment", contacts.map(contactLabel)),
              ...webhooks,
              data: contacts,
            },
            { signal: requestSignal, silentFail: options.silentFail }
          )
      )
      return {
        enrichment_id: started.enrichment_id,
        contacts: contacts.length,
        enrich_fields: enrichFields,
      }
    })
}

/** Create a `get_contact_enrichment` tool that reads an enrichment's results. */
export function fullEnrichGetContactEnrichment(
  connectorDefinition: FullEnrichConnectorDefinition,
  options: FullEnrichToolOptions = {}
): FullEnrichGetContactEnrichmentTool {
  const timeoutMs = resolveTimeout(options)

  return defineAgentTool("get_contact_enrichment")
    .description(
      "Read the emails, phones, and profiles found by start_contact_enrichment. Returns " +
        "ready: false while the enrichment is running; check again later rather than repeatedly. " +
        "Email status DELIVERABLE is safest; HIGH_PROBABILITY and CATCH_ALL may bounce."
    )
    .input(ENRICHMENT_ID_INPUT)
    .run(async ({ input, sixb: { connector }, signal }) => {
      const enrichmentId = requiredString(
        input.enrichment_id,
        "enrichment_id",
        "get_contact_enrichment"
      )
      const enrichment = await readJob(
        { connectorDefinition, connector, signal, timeoutMs, toolName: "get_contact_enrichment" },
        (client, requestSignal) => client.enrichments.get(enrichmentId, { signal: requestSignal })
      )
      if (!enrichment) return { enrichment_id: enrichmentId, ready: false, status: "IN_PROGRESS" }
      return {
        enrichment_id: enrichment.id,
        ready: isReady(enrichment.status),
        status: enrichment.status,
        ...creditsOutput(enrichment.cost?.credits),
        // An empty list while running would read as "nothing found".
        ...(isReady(enrichment.status)
          ? { contacts: (enrichment.data ?? []).slice(0, MAX_BATCH_SIZE).map(enrichmentRecord) }
          : {}),
      }
    })
}

// ── Reverse email lookup ────────────────────────────────────

/** Create a `start_reverse_email_lookup` tool that identifies the people behind emails. */
export function fullEnrichStartReverseEmailLookup(
  connectorDefinition: FullEnrichConnectorDefinition,
  options: FullEnrichStartReverseEmailLookupOptions = {}
): FullEnrichStartReverseEmailLookupTool {
  const timeoutMs = resolveTimeout(options)
  const maxEmails = resolveLimit(
    options.maxEmails,
    DEFAULT_MAX_CONTACTS,
    MAX_BATCH_SIZE,
    "maxEmails"
  )
  const webhooks = resolveWebhooks(options)

  return defineAgentTool("start_reverse_email_lookup")
    .description(
      `Start identifying the person and company behind up to ${maxEmails} email addresses. ` +
        "Costs 1 credit per identified email. Takes 30 to 90 seconds; this returns a lookup_id " +
        "to pass to get_reverse_email_lookup later."
    )
    .input(REVERSE_EMAIL_LOOKUP_INPUT)
    .run(async ({ input, sixb: { connector }, signal }) => {
      assertCount(input.emails.length, maxEmails, "emails", "start_reverse_email_lookup")
      const emails = input.emails.map((value, index) => {
        const email = value.trim()
        if ((!email.includes("@") || email.length > MAX_INPUT_CHARACTERS) && !options.silentFail) {
          throw new AgentToolPublicError(
            `[SixbFullEnrich] start_reverse_email_lookup emails[${index}] must be an email address.`
          )
        }
        return email
      })

      const started = await callFullEnrich(
        {
          connectorDefinition,
          connector,
          signal,
          timeoutMs,
          toolName: "start_reverse_email_lookup",
        },
        (client, requestSignal) =>
          client.reverseEmailLookups.start(
            {
              name: jobName("Reverse email lookup", emails),
              ...webhooks,
              data: emails.map((email) => ({ email })),
            },
            { signal: requestSignal, silentFail: options.silentFail }
          )
      )
      return { lookup_id: started.enrichment_id, emails: emails.length }
    })
}

/** Create a `get_reverse_email_lookup` tool that reads a reverse email lookup's results. */
export function fullEnrichGetReverseEmailLookup(
  connectorDefinition: FullEnrichConnectorDefinition,
  options: FullEnrichToolOptions = {}
): FullEnrichGetReverseEmailLookupTool {
  const timeoutMs = resolveTimeout(options)

  return defineAgentTool("get_reverse_email_lookup")
    .description(
      "Read the people identified by start_reverse_email_lookup. Returns ready: false while " +
        "the lookup is running; check again later rather than repeatedly."
    )
    .input(LOOKUP_ID_INPUT)
    .run(async ({ input, sixb: { connector }, signal }) => {
      const lookupId = requiredString(input.lookup_id, "lookup_id", "get_reverse_email_lookup")
      const lookup = await readJob(
        { connectorDefinition, connector, signal, timeoutMs, toolName: "get_reverse_email_lookup" },
        (client, requestSignal) =>
          client.reverseEmailLookups.get(lookupId, { signal: requestSignal })
      )
      if (!lookup) return { lookup_id: lookupId, ready: false, status: "IN_PROGRESS" }
      return {
        lookup_id: lookup.id,
        ready: isReady(lookup.status),
        status: lookup.status,
        ...creditsOutput(lookup.cost?.credits),
        // An empty list while running would read as "nothing found".
        ...(isReady(lookup.status)
          ? { results: (lookup.data ?? []).slice(0, MAX_BATCH_SIZE).map(reverseEmailRecord) }
          : {}),
      }
    })
}

// ── Account ─────────────────────────────────────────────────

/** Create a `get_enrichment_credits` tool that reads the workspace's credit balance. */
export function fullEnrichCreditBalance(
  connectorDefinition: FullEnrichConnectorDefinition,
  options: FullEnrichToolOptions = {}
): FullEnrichCreditBalanceTool {
  const timeoutMs = resolveTimeout(options)

  return defineAgentTool("get_enrichment_credits")
    .description("Read the FullEnrich credits remaining for search, lookup, and enrichment.")
    .input({})
    .run(async ({ sixb: { connector }, signal }) => {
      const credits = await callFullEnrich(
        { connectorDefinition, connector, signal, timeoutMs, toolName: "get_enrichment_credits" },
        (client, requestSignal) => client.account.credits({ signal: requestSignal })
      )
      return { balance: credits.balance }
    })
}

// ── Shared ──────────────────────────────────────────────────

interface ToolCall {
  readonly connectorDefinition: FullEnrichConnectorDefinition
  readonly connector: ConnectorRuntime
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly toolName: string
}

/** Bound connector resolution and the provider request by the run signal and the tool timeout. */
async function callFullEnrich<T>(
  call: ToolCall,
  request: (client: FullEnrichClient, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(call.timeoutMs)
  const signal = AbortSignal.any([call.signal, timeoutSignal])
  try {
    signal.throwIfAborted()
    const response = await waitForSignal(
      (async () => request(await call.connector(call.connectorDefinition), signal))(),
      signal
    )
    signal.throwIfAborted()
    return response
  } catch (error) {
    if (call.signal.aborted) throw call.signal.reason ?? error
    if (timeoutSignal.aborted) {
      throw new AgentToolPublicError(
        `[SixbFullEnrich] ${call.toolName} timed out after ${call.timeoutMs}ms.`,
        { cause: error }
      )
    }
    throw error
  }
}

function isReady(status: FullEnrichJobStatus): boolean {
  return status !== "CREATED" && status !== "IN_PROGRESS"
}

/**
 * A running job answers 200 with `IN_PROGRESS`; FullEnrich also documents a 400 `*.in_progress`
 * for it, so report that as not ready too.
 */
async function readJob<T>(
  call: ToolCall,
  request: (client: FullEnrichClient, signal: AbortSignal) => Promise<T>
): Promise<T | undefined> {
  try {
    return await callFullEnrich(call, request)
  } catch (error) {
    if (error instanceof FullEnrichApiError && error.code?.endsWith(".in_progress")) {
      return undefined
    }
    throw error
  }
}

function pageLimit(value: number | undefined, maxResults: number, toolName: string): number {
  const limit = value ?? Math.min(DEFAULT_PAGE_SIZE, maxResults)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxResults) {
    throw new AgentToolPublicError(
      `[SixbFullEnrich] ${toolName} page.limit must be an integer from 1 to ${maxResults}.`
    )
  }
  return limit
}

function pageCursor(value: string | undefined, toolName: string): string | undefined {
  const cursor = value?.trim()
  if (cursor && cursor.length > MAX_INPUT_CHARACTERS * 4) {
    throw new AgentToolPublicError(`[SixbFullEnrich] ${toolName} page.cursor is not valid.`)
  }
  return cursor || undefined
}

function pageOutput(
  metadata: FullEnrichSearchMetadata | undefined,
  returned: number,
  limit: number
): Record<string, JsonValue> {
  // FullEnrich returns a cursor even after the last result; only the first page reports `total`.
  const exhausted =
    typeof metadata?.total === "number" && (metadata.offset ?? 0) + returned >= metadata.total
  return {
    ...(typeof metadata?.total === "number" ? { total: metadata.total } : {}),
    ...creditsOutput(metadata?.credits),
    ...(metadata?.search_after && returned === limit && !exhausted
      ? { next_cursor: metadata.search_after }
      : {}),
  }
}

function creditsOutput(credits: number | undefined): Record<string, JsonValue> {
  return typeof credits === "number" && Number.isFinite(credits) ? { credits } : {}
}

function assertCount(count: number, max: number, field: string, toolName: string): void {
  if (count < 1 || count > max) {
    throw new AgentToolPublicError(
      `[SixbFullEnrich] ${toolName} ${field} must contain from 1 to ${max} entries.`
    )
  }
}

function requiredString(value: string, field: string, toolName: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_INPUT_CHARACTERS) {
    throw new AgentToolPublicError(`[SixbFullEnrich] ${toolName} ${field} must not be empty.`)
  }
  return trimmed
}

/** Trim model strings and drop empty ones, so `""` never stands in for an identifier. */
function trimStrings<T extends Readonly<Record<string, unknown>>>(value: T, toolName: string): T {
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      if (entry !== undefined) result[key] = entry
      continue
    }
    const trimmed = entry.trim()
    if (trimmed.length > MAX_INPUT_CHARACTERS) {
      throw new AgentToolPublicError(
        `[SixbFullEnrich] ${toolName} ${key} must contain at most ${MAX_INPUT_CHARACTERS} characters.`
      )
    }
    if (trimmed) result[key] = trimmed
  }
  return result as T
}

function contactLabel(contact: FullEnrichContactInput): string {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ")
  return name || contact.linkedin_url || contact.domain || contact.company_name || "contact"
}

/** A readable dashboard name, such as `Enrichment: Jane Doe +2 more`. */
function jobName(kind: string, labels: readonly string[]): string {
  const more = labels.length > 1 ? ` +${labels.length - 1} more` : ""
  return `${kind}: ${labels[0] ?? "contact"}${more}`
}

function resolveTimeout(options: FullEnrichToolOptions): number {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("[SixbFullEnrich] tool options must be an object.")
  }
  return resolveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, 2_147_483_647, "timeoutMs")
}

function resolveLimit(
  value: number | undefined,
  fallback: number,
  max: number,
  field: string
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw new Error(`[SixbFullEnrich] ${field} must be an integer from 1 to ${max}.`)
  }
  return resolved
}

function resolveAllowedFields(
  fields: readonly FullEnrichEnrichField[] | undefined
): readonly FullEnrichEnrichField[] {
  if (fields === undefined) return ENRICH_FIELDS
  if (
    !Array.isArray(fields) ||
    fields.length === 0 ||
    !fields.every((field) => ENRICH_FIELDS.includes(field))
  ) {
    throw new Error(
      `[SixbFullEnrich] allowedFields must list one or more of ${ENRICH_FIELDS.join(", ")}.`
    )
  }
  return [...new Set(fields)]
}

function resolveWebhooks(options: FullEnrichStartJobToolOptions) {
  for (const [field, url] of [
    ["webhookUrl", options.webhookUrl],
    ["contactFinishedWebhookUrl", options.contactFinishedWebhookUrl],
  ] as const) {
    if (url !== undefined && !/^https?:\/\//i.test(url)) {
      throw new Error(`[SixbFullEnrich] ${field} must be an absolute HTTP(S) URL.`)
    }
  }
  return {
    ...(options.webhookUrl ? { webhook_url: options.webhookUrl } : {}),
    ...(options.contactFinishedWebhookUrl
      ? { webhook_events: { contact_finished: options.contactFinishedWebhookUrl } }
      : {}),
  }
}
