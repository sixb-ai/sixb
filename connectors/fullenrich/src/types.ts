import type { ConnectorAdapter, Logger, Sixb } from "@sixb/core"

export type FullEnrichApiKeyResolver = string | (() => string | Promise<string>)

export interface FullEnrichConnectorOptions {
  /** API key from https://app.fullenrich.com/app/api. A resolver runs for every request. */
  readonly apiKey: FullEnrichApiKeyResolver
  /** API base URL. Defaults to https://app.fullenrich.com/api/v2/. */
  readonly baseUrl?: string
  /** Per-attempt request timeout. Defaults to 30 seconds. */
  readonly timeoutMs?: number
  /** Minimum delay between request starts on one connection. Defaults to 0. */
  readonly minDelayMs?: number
  /** Retries for reads that fail with 429 or 5xx. Defaults to 2; starting a job never retries. */
  readonly maxRetries?: number
  /** Registers the `enrichments` webhook and receives each verified enrichment delivery. */
  readonly onEnrichmentResult?: FullEnrichWebhookHandler<FullEnrichEnrichment>
  /** Registers the `reverse-email-lookups` webhook and receives each verified lookup delivery. */
  readonly onReverseEmailLookupResult?: FullEnrichWebhookHandler<FullEnrichReverseEmailLookup>
}

export interface FullEnrichRequestOptions {
  readonly signal?: AbortSignal
}

// ── Shared ──────────────────────────────────────────────────

/** Lifecycle of an asynchronous enrichment or reverse email lookup. */
export type FullEnrichJobStatus =
  | "CREATED"
  | "IN_PROGRESS"
  | "CANCELED"
  | "CREDITS_INSUFFICIENT"
  | "FINISHED"
  | "RATE_LIMIT"
  | "UNKNOWN"

export interface FullEnrichCost {
  readonly credits?: number
}

/** Per-event webhook URLs. `contact_finished` fires once per processed contact. */
export interface FullEnrichWebhookEvents {
  readonly contact_finished?: string
}

/** Caller metadata returned unchanged with each result. Values must be strings. */
export type FullEnrichCustomFields = Readonly<Record<string, string>>

export interface FullEnrichStartJobOptions extends FullEnrichRequestOptions {
  /** Skip contacts with invalid or missing input instead of rejecting the whole batch. */
  readonly silentFail?: boolean
}

export interface FullEnrichStartJobResponse {
  readonly enrichment_id: string
}

// ── Profiles ────────────────────────────────────────────────
// FullEnrich answers `null` for some empty lists, which its published schema does not declare.

export interface FullEnrichProfessionalNetworkProfile {
  readonly id?: number
  readonly url?: string
  readonly handle?: string
  readonly connection_count?: number
}

export interface FullEnrichSocialProfiles {
  readonly professional_network?: FullEnrichProfessionalNetworkProfile
}

export interface FullEnrichCompanyAddress {
  readonly line1?: string
  readonly line2?: string
  readonly city?: string
  readonly region?: string
  readonly country?: string
  readonly country_code?: string
}

export interface FullEnrichOfficeAddress {
  readonly line1?: string
  readonly line2?: string
}

export interface FullEnrichTechnology {
  readonly name?: string
  readonly logo_url?: string
}

export interface FullEnrichCompany {
  readonly id?: string
  readonly name?: string
  readonly domain?: string
  readonly website?: string
  readonly description?: string
  readonly year_founded?: number
  readonly headcount?: number
  readonly headcount_range?: string
  readonly company_type?: string
  readonly specialties?: readonly string[] | null
  readonly technologies?: readonly FullEnrichTechnology[] | null
  readonly locations?: {
    readonly headquarters?: FullEnrichCompanyAddress
    readonly offices?: readonly FullEnrichOfficeAddress[] | null
  }
  readonly industry?: {
    readonly main_industry?: string
  }
  readonly social_profiles?: FullEnrichSocialProfiles
  readonly logo_url?: string
}

export interface FullEnrichJobFunction {
  readonly function?: string
  readonly sub_function?: string
}

export interface FullEnrichEmployment {
  readonly title?: string
  readonly seniority?: string
  readonly job_functions?: readonly FullEnrichJobFunction[] | null
  readonly description?: string
  readonly company?: FullEnrichCompany
  readonly is_current?: boolean
  readonly start_at?: string
  readonly end_at?: string
}

export interface FullEnrichEducation {
  readonly school_name?: string
  readonly degree?: string
  readonly start_at?: string
  readonly end_at?: string
}

export interface FullEnrichLanguage {
  readonly language?: string
  readonly proficiency?: string
}

export interface FullEnrichPersonLocation {
  readonly country?: string
  readonly country_code?: string
  readonly city?: string
  readonly region?: string
}

export interface FullEnrichPerson {
  readonly id?: string
  readonly full_name?: string
  readonly first_name?: string
  readonly last_name?: string
  readonly headline?: string
  readonly description?: string
  readonly location?: FullEnrichPersonLocation
  readonly social_profiles?: FullEnrichSocialProfiles
  readonly educations?: readonly FullEnrichEducation[] | null
  readonly languages?: readonly FullEnrichLanguage[] | null
  readonly skills?: readonly string[] | null
  readonly employment?: {
    readonly current?: FullEnrichEmployment
    readonly all?: readonly FullEnrichEmployment[] | null
  }
}

// ── Contact enrichment ──────────────────────────────────────

export type FullEnrichEnrichField =
  | "contact.work_emails"
  | "contact.personal_emails"
  | "contact.phones"

/**
 * One contact to enrich. Provide `linkedin_url`, or `first_name` + `last_name` with `domain` or
 * `company_name`. A LinkedIn URL also returns the person's full profile.
 */
export interface FullEnrichContactInput {
  readonly first_name?: string
  readonly last_name?: string
  readonly domain?: string
  readonly company_name?: string
  /** Standard or Sales Navigator LinkedIn profile URL. */
  readonly linkedin_url?: string
  readonly enrich_fields: readonly FullEnrichEnrichField[]
  readonly custom?: FullEnrichCustomFields
}

export interface FullEnrichStartEnrichmentRequest {
  /** Readable name shown in the FullEnrich dashboard. */
  readonly name: string
  /** Receives the whole result when the batch finishes, runs out of credits, or is canceled. */
  readonly webhook_url?: string
  readonly webhook_events?: FullEnrichWebhookEvents
  /** From 1 to 100 contacts. */
  readonly data: readonly FullEnrichContactInput[]
}

export interface FullEnrichGetEnrichmentOptions extends FullEnrichRequestOptions {
  /** Return what has been found so far, even when the enrichment is not finished. */
  readonly forceResults?: boolean
}

export type FullEnrichEmailStatus =
  | "DELIVERABLE"
  | "HIGH_PROBABILITY"
  | "CATCH_ALL"
  | "INVALID"
  | "INVALID_DOMAIN"

export interface FullEnrichEmail {
  readonly email?: string
  readonly status?: FullEnrichEmailStatus
}

export interface FullEnrichPhone {
  /** Formatted for international display. */
  readonly number?: string
  /** ISO 3166-1 alpha-2 country where the number is registered. */
  readonly region?: string
  readonly line_type?: "MOBILE" | "LANDLINE" | "VOIP" | "UNKNOWN"
  readonly line_status?: "ACTIVE" | "INACTIVE" | "UNKNOWN"
  /** US and Canadian numbers only. */
  readonly ownership_match?: "CONFIRMED" | "MISMATCH"
  readonly ownership_match_confidence?: number
  readonly connect_rate?: "HIGHEST" | "HIGH" | "MEDIUM"
}

export interface FullEnrichContactInfo {
  readonly most_probable_work_email?: FullEnrichEmail | null
  readonly most_probable_personal_email?: FullEnrichEmail | null
  readonly most_probable_phone?: FullEnrichPhone | null
  readonly work_emails?: readonly FullEnrichEmail[] | null
  readonly personal_emails?: readonly FullEnrichEmail[] | null
  /** Every candidate, including numbers not eligible for `most_probable_phone`. */
  readonly phones?: readonly FullEnrichPhone[] | null
}

/** The input FullEnrich echoes back for one enriched contact. */
export interface FullEnrichEnrichmentInput {
  readonly first_name?: string
  readonly last_name?: string
  readonly full_name?: string
  readonly company_domain?: string
  readonly company_name?: string
  readonly professional_network_url?: string
}

export interface FullEnrichEnrichmentRecord {
  readonly input?: FullEnrichEnrichmentInput
  readonly custom?: FullEnrichCustomFields
  readonly contact_info?: FullEnrichContactInfo
  readonly profile?: FullEnrichPerson | null
}

export interface FullEnrichEnrichment {
  readonly id: string
  readonly name?: string
  readonly status: FullEnrichJobStatus
  /** Absent while the job is running, unless `forceResults` is set. */
  readonly data?: readonly FullEnrichEnrichmentRecord[]
  readonly cost?: FullEnrichCost
}

// ── Reverse email lookup ────────────────────────────────────

export interface FullEnrichReverseEmailInput {
  readonly email: string
  readonly custom?: FullEnrichCustomFields
}

export interface FullEnrichStartReverseEmailLookupRequest {
  readonly name: string
  readonly webhook_url?: string
  readonly webhook_events?: FullEnrichWebhookEvents
  /** From 1 to 100 emails. */
  readonly data: readonly FullEnrichReverseEmailInput[]
}

export interface FullEnrichReverseEmailRecord {
  readonly input?: { readonly email?: string }
  readonly custom?: FullEnrichCustomFields
  readonly profile?: FullEnrichPerson | null
}

export interface FullEnrichReverseEmailLookup {
  readonly id: string
  readonly name?: string
  readonly status: FullEnrichJobStatus
  readonly data?: readonly FullEnrichReverseEmailRecord[]
  readonly cost?: FullEnrichCost
}

// ── Search and lookup ───────────────────────────────────────

/**
 * One value of a search filter. Values of one filter are ORed; different filters are ANDed.
 * `exact_match` requires the stored value to match case-insensitively; by default minor
 * differences such as missing or extra words still match.
 */
export interface FullEnrichTextFilter {
  readonly value: string
  readonly exclude?: boolean
  readonly exact_match?: boolean
}

export interface FullEnrichIntegerFilter {
  readonly value: number
  readonly exclude?: boolean
  readonly exact_match?: boolean
}

/** An inclusive range. */
export interface FullEnrichRangeFilter {
  readonly min?: number
  readonly max?: number
  readonly exclude?: boolean
}

export interface FullEnrichSearchPage {
  /** Results to skip, at most 10,000. Use `search_after` beyond that. */
  readonly offset?: number
  /** Results to return, from 1 to 100. The API defaults to 10. */
  readonly limit?: number
  /** Cursor from the previous response's `metadata.search_after`. */
  readonly search_after?: string
}

export interface FullEnrichPeopleSearchRequest extends FullEnrichSearchPage {
  readonly current_company_names?: readonly FullEnrichTextFilter[]
  readonly current_company_domains?: readonly FullEnrichTextFilter[]
  readonly current_company_professional_network_ids?: readonly FullEnrichIntegerFilter[]
  readonly current_company_professional_network_urls?: readonly FullEnrichTextFilter[]
  readonly current_company_specialties?: readonly FullEnrichTextFilter[]
  readonly current_company_industries?: readonly FullEnrichTextFilter[]
  readonly current_company_technologies?: readonly FullEnrichTextFilter[]
  readonly current_company_types?: readonly FullEnrichTextFilter[]
  readonly current_company_headquarters?: readonly FullEnrichTextFilter[]
  readonly current_company_headcounts?: readonly FullEnrichRangeFilter[]
  readonly current_company_founded_years?: readonly FullEnrichRangeFilter[]
  readonly current_company_ids?: readonly FullEnrichTextFilter[]
  readonly current_company_years_at?: readonly FullEnrichRangeFilter[]
  readonly current_company_days_since_last_job_change?: readonly FullEnrichRangeFilter[]
  readonly past_company_names?: readonly FullEnrichTextFilter[]
  readonly past_company_domains?: readonly FullEnrichTextFilter[]
  readonly person_ids?: readonly FullEnrichTextFilter[]
  readonly person_names?: readonly FullEnrichTextFilter[]
  readonly person_professional_network_ids?: readonly FullEnrichIntegerFilter[]
  readonly person_professional_network_urls?: readonly FullEnrichTextFilter[]
  readonly person_locations?: readonly FullEnrichTextFilter[]
  readonly person_languages?: readonly FullEnrichTextFilter[]
  readonly person_skills?: readonly FullEnrichTextFilter[]
  readonly person_universities?: readonly FullEnrichTextFilter[]
  readonly current_position_seniority_level?: readonly FullEnrichTextFilter[]
  readonly current_position_job_functions?: readonly FullEnrichTextFilter[]
  readonly current_position_sub_functions?: readonly FullEnrichTextFilter[]
  readonly current_position_titles?: readonly FullEnrichTextFilter[]
  readonly current_position_years_in?: readonly FullEnrichRangeFilter[]
  readonly past_position_titles?: readonly FullEnrichTextFilter[]
}

export interface FullEnrichCompanySearchRequest extends FullEnrichSearchPage {
  readonly names?: readonly FullEnrichTextFilter[]
  readonly domains?: readonly FullEnrichTextFilter[]
  readonly professional_network_ids?: readonly FullEnrichIntegerFilter[]
  readonly professional_network_urls?: readonly FullEnrichTextFilter[]
  /** Matches the company description. */
  readonly keywords?: readonly FullEnrichTextFilter[]
  readonly specialties?: readonly FullEnrichTextFilter[]
  readonly technologies?: readonly FullEnrichTextFilter[]
  readonly industries?: readonly FullEnrichTextFilter[]
  readonly types?: readonly FullEnrichTextFilter[]
  readonly headquarters_locations?: readonly FullEnrichTextFilter[]
  readonly founded_years?: readonly FullEnrichRangeFilter[]
  readonly headcounts?: readonly FullEnrichRangeFilter[]
  readonly company_ids?: readonly FullEnrichTextFilter[]
}

export interface FullEnrichSearchMetadata {
  readonly total?: number
  /** Credits charged for this page. */
  readonly credits?: number
  readonly offset?: number
  /** Cursor for the next page. */
  readonly search_after?: string
}

export interface FullEnrichPeopleSearchResponse {
  readonly people: readonly FullEnrichPerson[]
  readonly metadata?: FullEnrichSearchMetadata
}

export interface FullEnrichCompanySearchResponse {
  readonly companies: readonly FullEnrichCompany[]
  readonly metadata?: FullEnrichSearchMetadata
}

/**
 * Identify a person by LinkedIn URL or ID, or by full name combined with a company domain,
 * LinkedIn URL, or LinkedIn ID.
 */
export interface FullEnrichPersonLookupRequest {
  readonly person_name?: string
  readonly person_professional_network_url?: string
  readonly person_professional_network_id?: number
  readonly company_professional_network_url?: string
  readonly company_professional_network_id?: number
  readonly company_domain?: string
}

/** Identify a company by domain, LinkedIn URL, or LinkedIn ID. */
export interface FullEnrichCompanyLookupRequest {
  readonly domain?: string
  readonly professional_network_url?: string
  readonly professional_network_id?: number
}

export interface FullEnrichLookupMetadata {
  readonly credits?: number
  readonly offset?: number
}

/** Contains at most one person. */
export interface FullEnrichPersonLookupResponse {
  readonly people: readonly FullEnrichPerson[]
  readonly metadata?: FullEnrichLookupMetadata
}

/** Contains at most one company. */
export interface FullEnrichCompanyLookupResponse {
  readonly companies: readonly FullEnrichCompany[]
  readonly metadata?: FullEnrichLookupMetadata
}

// ── Account ─────────────────────────────────────────────────

export interface FullEnrichCreditBalance {
  readonly balance: number
}

export interface FullEnrichApiKeyInfo {
  readonly workspace_id: string
}

// ── Client ──────────────────────────────────────────────────

export interface FullEnrichEnrichmentsResource {
  /** Start an asynchronous enrichment. Never retried: a replay would start a second job. */
  start(
    request: FullEnrichStartEnrichmentRequest,
    options?: FullEnrichStartJobOptions
  ): Promise<FullEnrichStartJobResponse>
  /**
   * Read an enrichment. A running job reports `IN_PROGRESS` without `data` unless `forceResults`
   * is set; a job that ran out of credits returns `CREDITS_INSUFFICIENT` with its partial data.
   */
  get(enrichmentId: string, options?: FullEnrichGetEnrichmentOptions): Promise<FullEnrichEnrichment>
}

export interface FullEnrichReverseEmailLookupsResource {
  /** Start an asynchronous reverse email lookup. Never retried. */
  start(
    request: FullEnrichStartReverseEmailLookupRequest,
    options?: FullEnrichStartJobOptions
  ): Promise<FullEnrichStartJobResponse>
  get(lookupId: string, options?: FullEnrichRequestOptions): Promise<FullEnrichReverseEmailLookup>
}

export interface FullEnrichPeopleResource {
  search(
    request?: FullEnrichPeopleSearchRequest,
    options?: FullEnrichRequestOptions
  ): Promise<FullEnrichPeopleSearchResponse>
  /** Follow `search_after` cursors until the results run out. Every result costs credits. */
  searchAll(
    request?: FullEnrichPeopleSearchRequest,
    options?: FullEnrichRequestOptions
  ): AsyncIterable<FullEnrichPerson>
  lookup(
    request: FullEnrichPersonLookupRequest,
    options?: FullEnrichRequestOptions
  ): Promise<FullEnrichPersonLookupResponse>
}

export interface FullEnrichCompaniesResource {
  search(
    request?: FullEnrichCompanySearchRequest,
    options?: FullEnrichRequestOptions
  ): Promise<FullEnrichCompanySearchResponse>
  /** Follow `search_after` cursors until the results run out. Every result costs credits. */
  searchAll(
    request?: FullEnrichCompanySearchRequest,
    options?: FullEnrichRequestOptions
  ): AsyncIterable<FullEnrichCompany>
  lookup(
    request: FullEnrichCompanyLookupRequest,
    options?: FullEnrichRequestOptions
  ): Promise<FullEnrichCompanyLookupResponse>
}

export interface FullEnrichAccountResource {
  credits(options?: FullEnrichRequestOptions): Promise<FullEnrichCreditBalance>
  verifyKey(options?: FullEnrichRequestOptions): Promise<FullEnrichApiKeyInfo>
}

/** Typed FullEnrich client, grouped by resource. */
export interface FullEnrichClient {
  readonly enrichments: FullEnrichEnrichmentsResource
  readonly reverseEmailLookups: FullEnrichReverseEmailLookupsResource
  readonly people: FullEnrichPeopleResource
  readonly companies: FullEnrichCompaniesResource
  readonly account: FullEnrichAccountResource
}

export type FullEnrichConnector = ConnectorAdapter<"fullenrich", FullEnrichClient>

// ── Webhooks ────────────────────────────────────────────────

export interface FullEnrichWebhookContext<TResult> {
  /**
   * The delivered job. A per-contact `contact_finished` delivery has status `IN_PROGRESS` and one
   * record; the batch delivery carries every record.
   */
  readonly result: TResult
  readonly sixb: Sixb
  readonly logger: Logger
  client(): Promise<FullEnrichClient>
}

export type FullEnrichWebhookHandler<TResult> = (
  context: FullEnrichWebhookContext<TResult>
) => Promise<void> | void
