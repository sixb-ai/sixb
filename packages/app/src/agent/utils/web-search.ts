import type { NormalizedPart } from "../parts"
import { webFetchSource } from "./web-fetch"

export interface WebSource {
  readonly id: string
  readonly url: string
  readonly domain: string
  readonly faviconUrl: string
  readonly title: string
  readonly excerpt: string
  readonly author?: string
  /** ISO date as published by the source; see {@link formatPublicationDate}. */
  readonly publishedDate?: string
}

/** A publication date in the reader's language. Sources publish calendar dates, read in UTC. */
export function formatPublicationDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value))
}

/**
 * Recognize a `web_search` output: Sixb's hits (`snippet`, `publishedAt`), and the Exa tool's
 * that older threads stored (`text`, `author`, `publishedDate`).
 */
export function coerceWebSearchOutput(value: unknown): readonly WebSource[] | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null

  const sources: WebSource[] = []
  for (const result of value.results) {
    if (!isRecord(result) || typeof result.url !== "string" || typeof result.title !== "string") {
      return null
    }

    const text = typeof result.snippet === "string" ? result.snippet : result.text
    if (typeof text !== "string") return null

    const source = webSource(result.url, result.title, text)
    if (!source) continue

    sources.push({
      ...source,
      author: typeof result.author === "string" ? compact(result.author) : undefined,
      publishedDate: publicationDate(result.publishedAt ?? result.publishedDate),
    })
  }

  // Invalid links are not evidence that a search returned zero results. Keep the inspector.
  return value.results.length > 0 && sources.length === 0 ? null : sources
}

/** A page as a source, or null when its link is not a plain web address. */
export function webSource(url: string, title: string, text: string): WebSource | null {
  const parsed = httpUrl(url)
  if (!parsed) return null

  const page = new URL(parsed)
  page.hash = ""
  return {
    id: page.href,
    url: parsed.href,
    domain: displayDomain(parsed),
    faviconUrl: new URL("/favicon.ico", parsed.origin).href,
    title: compact(title) || fileName(parsed) || parsed.hostname,
    excerpt: excerpt(text),
  }
}

/** A host as people read it: without the `www.` prefix. */
export function displayDomain(url: URL): string {
  return url.hostname.replace(/^www\./, "")
}

export function webSearchQuery(input: unknown): string | undefined {
  return isRecord(input) && typeof input.query === "string" ? input.query.trim() : undefined
}

/**
 * Keep provider order and the first occurrence; separate pages on one domain remain separate. A
 * page the agent read counts too, unless it only pointed elsewhere.
 */
export function collectWebSources(parts: readonly NormalizedPart[]): readonly WebSource[] {
  const sources = new Map<string, WebSource>()
  const add = (source: WebSource) => {
    if (!sources.has(source.id)) sources.set(source.id, source)
  }

  for (const part of parts) {
    if (part.kind !== "tool" || part.tool.state !== "output-available") continue

    if (part.tool.toolName === "web_search") {
      for (const source of coerceWebSearchOutput(part.tool.output) ?? []) add(source)
    }

    if (part.tool.toolName === "web_fetch") {
      const source = webFetchSource(part.tool.output)
      if (source) add(source)
    }
  }
  return [...sources.values()]
}

/** A plain web address: http or https, with no credentials in it. */
export function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

/** The last segment of a URL's path, decoded: what a PDF or an image without a title is called. */
function fileName(url: URL): string {
  const segment = url.pathname.slice(url.pathname.lastIndexOf("/") + 1)
  try {
    return compact(decodeURIComponent(segment))
  } catch {
    return compact(segment)
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
  if (!Number.isFinite(new Date(value).getTime())) return
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
