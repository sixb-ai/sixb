import type { NormalizedPart } from "../parts"

const publicationDateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

export interface WebSource {
  readonly id: string
  readonly url: string
  readonly domain: string
  readonly faviconUrl: string
  readonly title: string
  readonly excerpt: string
  readonly author?: string
  readonly publishedDate?: string
}

/** Recognize the bounded Exa web_search output, without depending on the connector package. */
export function coerceWebSearchOutput(value: unknown): readonly WebSource[] | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null
  const sources: WebSource[] = []
  for (const result of value.results) {
    if (
      !isRecord(result) ||
      typeof result.url !== "string" ||
      typeof result.title !== "string" ||
      typeof result.text !== "string"
    ) {
      return null
    }
    const url = httpUrl(result.url)
    if (!url) continue
    const page = new URL(url)
    page.hash = ""
    sources.push({
      id: page.href,
      url: url.href,
      domain: url.hostname.replace(/^www\./, ""),
      faviconUrl: new URL("/favicon.ico", url.origin).href,
      title: compact(result.title) || url.hostname,
      excerpt: excerpt(result.text),
      author: typeof result.author === "string" ? compact(result.author) : undefined,
      publishedDate: publicationDate(result.publishedDate),
    })
  }
  // Invalid links are not evidence that a search returned zero results. Keep the inspector.
  return value.results.length > 0 && sources.length === 0 ? null : sources
}

export function webSearchQuery(input: unknown): string | undefined {
  return isRecord(input) && typeof input.query === "string" ? input.query.trim() : undefined
}

/** Keep provider order and the first occurrence; separate pages on one domain remain separate. */
export function collectWebSources(parts: readonly NormalizedPart[]): readonly WebSource[] {
  const sources = new Map<string, WebSource>()
  for (const part of parts) {
    if (
      part.kind !== "tool" ||
      part.tool.toolName !== "web_search" ||
      part.tool.state !== "output-available"
    ) {
      continue
    }
    for (const source of coerceWebSearchOutput(part.tool.output) ?? []) {
      if (!sources.has(source.id)) sources.set(source.id, source)
    }
  }
  return [...sources.values()]
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function excerpt(value: string): string {
  const text = compact(value)
  return text.length > 360 ? `${text.slice(0, 357).trimEnd()}…` : text
}

function publicationDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return
  return publicationDateFormatter.format(date)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
