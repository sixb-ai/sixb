import type { JsonValue } from "@sixb/core"
import type {
  FullEnrichCompany,
  FullEnrichCompanyAddress,
  FullEnrichEmail,
  FullEnrichEmployment,
  FullEnrichEnrichmentRecord,
  FullEnrichPerson,
  FullEnrichPhone,
  FullEnrichReverseEmailRecord,
} from "./types"

// Model-facing projections. Search results are summaries so a page stays small; lookups return
// the detail a follow-up question needs. Every list and free-text field is bounded.

type JsonRecord = { [key: string]: JsonValue }

const MAX_HEADLINE_CHARACTERS = 300
const MAX_SUMMARY_DESCRIPTION_CHARACTERS = 300
const MAX_DETAIL_DESCRIPTION_CHARACTERS = 2_000
const MAX_DETAIL_LIST_ENTRIES = 30
const MAX_EXPERIENCE_ENTRIES = 15
const MAX_CANDIDATES = 10

export function personSummary(person: FullEnrichPerson): JsonRecord {
  const current = person.employment?.current
  return compact({
    id: person.id,
    full_name: person.full_name,
    headline: truncate(person.headline, MAX_HEADLINE_CHARACTERS),
    location: joinParts([person.location?.city, person.location?.region, person.location?.country]),
    linkedin_url: person.social_profiles?.professional_network?.url,
    current_position: current ? position(current) : undefined,
  })
}

export function personDetail(person: FullEnrichPerson): JsonRecord {
  return compact({
    ...personSummary(person),
    description: truncate(person.description, MAX_DETAIL_DESCRIPTION_CHARACTERS),
    skills: strings(person.skills, MAX_DETAIL_LIST_ENTRIES),
    languages: strings(
      person.languages?.map((entry) =>
        entry.language && entry.proficiency
          ? `${entry.language} (${entry.proficiency})`
          : entry.language
      ),
      MAX_DETAIL_LIST_ENTRIES
    ),
    educations: records(
      person.educations?.map((education) =>
        compact({
          school_name: education.school_name,
          degree: education.degree,
          start_at: education.start_at,
          end_at: education.end_at,
        })
      ),
      MAX_DETAIL_LIST_ENTRIES
    ),
    experience: records(person.employment?.all?.map(position), MAX_EXPERIENCE_ENTRIES),
  })
}

export function companySummary(company: FullEnrichCompany): JsonRecord {
  return compact({
    id: company.id,
    name: company.name,
    domain: company.domain,
    website: company.website,
    industry: company.industry?.main_industry,
    headcount: company.headcount,
    headcount_range: company.headcount_range,
    company_type: company.company_type,
    year_founded: company.year_founded,
    headquarters: address(company.locations?.headquarters),
    linkedin_url: company.social_profiles?.professional_network?.url,
    description: truncate(company.description, MAX_SUMMARY_DESCRIPTION_CHARACTERS),
  })
}

export function companyDetail(company: FullEnrichCompany): JsonRecord {
  return compact({
    ...companySummary(company),
    description: truncate(company.description, MAX_DETAIL_DESCRIPTION_CHARACTERS),
    specialties: strings(company.specialties, MAX_DETAIL_LIST_ENTRIES),
    technologies: strings(
      company.technologies?.map((technology) => technology.name),
      MAX_DETAIL_LIST_ENTRIES
    ),
    offices: strings(
      company.locations?.offices?.map((office) => joinParts([office.line1, office.line2])),
      MAX_DETAIL_LIST_ENTRIES
    ),
  })
}

export function enrichmentRecord(record: FullEnrichEnrichmentRecord): JsonRecord {
  const info = record.contact_info
  return compact({
    input: compact({ ...record.input }),
    most_probable_work_email: info?.most_probable_work_email
      ? email(info.most_probable_work_email)
      : undefined,
    most_probable_personal_email: info?.most_probable_personal_email
      ? email(info.most_probable_personal_email)
      : undefined,
    most_probable_phone: info?.most_probable_phone ? phone(info.most_probable_phone) : undefined,
    work_emails: records(info?.work_emails?.map(email), MAX_CANDIDATES),
    personal_emails: records(info?.personal_emails?.map(email), MAX_CANDIDATES),
    phones: records(info?.phones?.map(phone), MAX_CANDIDATES),
    profile: record.profile ? personSummary(record.profile) : undefined,
  })
}

export function reverseEmailRecord(record: FullEnrichReverseEmailRecord): JsonRecord {
  return {
    ...compact({ email: record.input?.email }),
    person: record.profile ? personSummary(record.profile) : null,
  }
}

function position(employment: FullEnrichEmployment): JsonRecord {
  const company = employment.company
  return compact({
    title: employment.title,
    seniority: employment.seniority,
    company: company
      ? compact({
          id: company.id,
          name: company.name,
          domain: company.domain,
          industry: company.industry?.main_industry,
          headcount: company.headcount,
        })
      : undefined,
    is_current: employment.is_current,
    start_at: employment.start_at,
    end_at: employment.end_at,
  })
}

function email(value: FullEnrichEmail): JsonRecord {
  return compact({ email: value.email, status: value.status })
}

function phone(value: FullEnrichPhone): JsonRecord {
  return compact({ ...value })
}

function address(value: FullEnrichCompanyAddress | undefined): string | undefined {
  if (!value) return undefined
  return (
    joinParts([value.city, value.region, value.country]) ?? joinParts([value.line1, value.line2])
  )
}

function joinParts(parts: readonly (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => typeof part === "string" && !!part.trim())
  return present.length > 0 ? present.join(", ") : undefined
}

function strings(
  values: readonly (string | undefined)[] | null | undefined,
  max: number
): string[] | undefined {
  return values?.filter((value): value is string => typeof value === "string").slice(0, max)
}

function records(
  values: readonly JsonRecord[] | null | undefined,
  max: number
): JsonRecord[] | undefined {
  return values?.filter((value) => Object.keys(value).length > 0).slice(0, max)
}

function truncate(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** Drop absent, empty, and non-JSON values so projections carry only what FullEnrich found. */
function compact(value: Record<string, unknown>): JsonRecord {
  const result: JsonRecord = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === "") continue
    if (Array.isArray(entry) && entry.length === 0) continue
    if (typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 0) {
      continue
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) continue
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      typeof entry === "object"
    ) {
      result[key] = entry as JsonValue
    }
  }
  return result
}
