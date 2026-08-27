import type {
  LinkedinDate,
  LinkedinDateRange,
  LinkedinId,
  LinkedinOptionalDateRange,
  LinkedinPostUrn,
  LinkedinTimeIntervals,
  LinkedinTimeRange,
} from "./types/common"

export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | RestliQueryValue | undefined
export type QueryParams = Readonly<Record<string, QueryValue>>

interface RestliQueryValue {
  readonly kind: "restli"
  readonly encoded: string
}

/** Build a URL query while preserving Rest.li structural delimiters. */
export function withQuery(path: string, query?: QueryParams): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path
  if (!query) return normalizedPath

  const entries: string[] = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue
    const encoded = isRestliValue(value) ? value.encoded : encodeURIComponent(String(value))
    entries.push(`${encodeURIComponent(key)}=${encoded}`)
  }

  return entries.length > 0 ? `${normalizedPath}?${entries.join("&")}` : normalizedPath
}

/** Rest.li protocol 2.0 list, with each value encoded independently from the list syntax. */
export function restliList(values: readonly QueryScalar[]): RestliQueryValue {
  return restli(`List(${values.map((value) => encodeURIComponent(String(value))).join(",")})`)
}

/** Search document used by ad account, campaign group, and campaign finders. */
export function restliSearch(
  fields: Readonly<Record<string, readonly QueryScalar[] | boolean | undefined>>
): RestliQueryValue | undefined {
  const entries: string[] = []
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue
    entries.push(
      Array.isArray(value)
        ? `${field}:(values:${restliList(value).encoded})`
        : `${field}:${String(value)}`
    )
  }
  return entries.length > 0 ? restli(`(${entries.join(",")})`) : undefined
}

export function restliDateRange(value: LinkedinDateRange): RestliQueryValue {
  const start = restliDate(value.start)
  const end = value.end ? `,end:${restliDate(value.end)}` : ""
  return restli(`(start:${start}${end})`)
}

export function restliOptionalDateRange(value: LinkedinOptionalDateRange): RestliQueryValue {
  const start = value.start ? `start:${restliDate(value.start)}` : undefined
  const end = value.end ? `end:${restliDate(value.end)}` : undefined
  return restli(`(${[start, end].filter(Boolean).join(",")})`)
}

export function restliTimeRange(value: LinkedinTimeRange): RestliQueryValue {
  const start = value.start === undefined ? undefined : `start:${value.start}`
  const end = value.end === undefined ? undefined : `end:${value.end}`
  return restli(`(${[start, end].filter(Boolean).join(",")})`)
}

export function restliTimeIntervals(value: LinkedinTimeIntervals): RestliQueryValue {
  return restli(
    `(timeRange:${restliTimeRange(value.timeRange).encoded},timeGranularityType:${value.timeGranularityType})`
  )
}

/** Rest.li record whose scalar values are encoded independently from the record syntax. */
export function restliRecord(
  fields: Readonly<Record<string, QueryScalar | undefined>>
): RestliQueryValue {
  const entries = Object.entries(fields)
    .filter((entry): entry is [string, QueryScalar] => entry[1] !== undefined)
    .map(([key, value]) => `${key}:${encodeURIComponent(String(value))}`)
  return restli(`(${entries.join(",")})`)
}

/** Union record expected by member analytics for a share or UGC post entity. */
export function restliPostEntity(post: LinkedinPostUrn): RestliQueryValue {
  urnPath(post, "post URN")
  return restliRecord({ [post.startsWith("urn:li:share:") ? "share" : "ugc"]: post })
}

export function pathId(id: LinkedinId, field: string): string {
  const value = String(id)
  if (!/^\d+$/.test(value) || value === "0") {
    throw new Error(`[SixbLinkedin] ${field} must be a positive numeric ID.`)
  }
  return value
}

export function urnPath(value: string, field: string): string {
  assertNonEmpty(value, field)
  if (!value.startsWith("urn:li:")) {
    throw new Error(`[SixbLinkedin] ${field} must be a LinkedIn URN.`)
  }
  return encodeURIComponent(value)
}

export function assertNonEmpty(value: string, field: string): void {
  if (!value?.trim()) {
    throw new Error(`[SixbLinkedin] ${field} must not be empty.`)
  }
}

export function assertPageSize(value: number | undefined, max: number): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`[SixbLinkedin] pageSize must be an integer between 1 and ${max}.`)
  }
}

export function assertOffset(value: number | undefined, field: string, minimum: number): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `[SixbLinkedin] ${field} must be an integer greater than or equal to ${minimum}.`
    )
  }
}

function restli(encoded: string): RestliQueryValue {
  return { kind: "restli", encoded }
}

function isRestliValue(value: QueryValue): value is RestliQueryValue {
  return typeof value === "object" && value !== null && value.kind === "restli"
}

function restliDate(value: LinkedinDate): string {
  return `(year:${value.year},month:${value.month},day:${value.day})`
}
