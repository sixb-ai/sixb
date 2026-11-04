import { httpUrl, type WebSource, webSource } from "./web-search"

/** A `web_fetch` result, as the chat shows it. */
export interface WebFetchPage {
  readonly source: WebSource
  /** What the agent asked about the page. */
  readonly question?: string
  readonly answer?: string
  /** The answer stopped at its length limit: its end may be missing. */
  readonly answerTruncated: boolean
  /** The question went unanswered: the preview stands in for the answer. */
  readonly answerFailed: boolean
  /** The start of the page, or all of it when it is short. */
  readonly preview?: string
  /**
   * Another site the address sent the agent to, which it did not follow. Its host stays whole:
   * `example.com` sending to `www.example.com` would otherwise read as a redirect to itself.
   */
  readonly redirect?: { readonly url: string; readonly domain: string }
  // What the server sent: shown only in the opened row.
  readonly status?: number
  readonly contentType?: string
  readonly bytes?: number
  readonly truncated: boolean
}

/**
 * Recognize a `web_fetch` output: Sixb's (`source`, `answer`, `preview`), and the Exa tool's that
 * older threads stored (`title`, `url`, `content`).
 */
export function coerceWebFetchOutput(value: unknown): WebFetchPage | null {
  if (!isRecord(value)) return null

  if (typeof value.content === "string") {
    if (typeof value.url !== "string" || typeof value.title !== "string") return null

    const source = webSource(value.url, value.title, value.content)
    if (!source) return null

    return {
      source,
      preview: value.content,
      answerTruncated: false,
      answerFailed: false,
      truncated: false,
    }
  }

  if (!isRecord(value.source) || typeof value.source.url !== "string") return null

  // The page speaks for itself in the row; its source carries no excerpt of it.
  const source = webSource(value.source.url, text(value.source.title) ?? "", "")
  if (!source) return null

  const redirect = isRecord(value.redirect) ? httpUrl(text(value.redirect.url) ?? "") : null

  return {
    source,
    question: text(value.question),
    answer: text(value.answer),
    answerTruncated: value.answerTruncated === true,
    answerFailed: typeof value.answerError === "string",
    preview: text(value.preview),
    redirect: redirect ? { url: redirect.href, domain: redirect.hostname } : undefined,
    status: count(value.status),
    contentType: text(value.contentType),
    bytes: count(value.bytes),
    truncated: value.truncated === true,
  }
}

/** The page a `web_fetch` read, as a source; none when it only pointed elsewhere or failed. */
export function webFetchSource(value: unknown): WebSource | null {
  const page = coerceWebFetchOutput(value)
  if (!page || page.redirect) return null
  if (page.status !== undefined && (page.status < 200 || page.status >= 300)) return null
  return page.source
}

export function webFetchUrl(input: unknown): URL | null {
  if (!isRecord(input) || typeof input.url !== "string") return null
  return httpUrl(input.url)
}

export function webFetchQuestion(input: unknown): string | undefined {
  return isRecord(input) ? text(input.question) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
