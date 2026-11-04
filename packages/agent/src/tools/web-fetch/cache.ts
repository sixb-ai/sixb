/** A page as `web_fetch` read it: what it saves, never what a question made of it. */
export interface CachedWebPage {
  /** The final URL, after the same-host redirects that were followed. */
  readonly url: string
  readonly title: string
  readonly status: number
  /** The media type the server sent, lowercased, or empty when it sent none. */
  readonly contentType: string
  /** The page as it is saved: markdown or text, or a PDF or image as it came. */
  readonly body: Uint8Array
  readonly kind: WebPageKind
  /** How many bytes the server sent, up to the fetch cap. */
  readonly size: number
  /** The body stopped at the fetch cap, or an HTML page was converted only up to its own. */
  readonly truncated: boolean
}

/** What a saved page is, by its file's extension and media type. */
export interface WebPageKind {
  readonly extension: "md" | "txt" | "pdf" | "png" | "jpg" | "gif" | "webp"
  readonly mediaType: string
}

const MAX_BYTES = 64 * 1024 * 1024
const TTL_MS = 15 * 60_000

/** What an entry weighs beyond its body: its strings, roughly. */
const ENTRY_OVERHEAD_BYTES = 1_024

interface Entry {
  readonly page: CachedWebPage
  readonly bytes: number
  readonly expiresAt: number
}

/**
 * The pages a runner process fetched in the last 15 minutes, by URL, up to 64 MB: a run that
 * reads a page again, or another run that reads it, does not fetch it again. Least recently used
 * pages go first.
 */
export class WebFetchCache {
  readonly #entries = new Map<string, Entry>()
  #bytes = 0

  get(url: URL): CachedWebPage | undefined {
    const key = cacheKey(url)
    const entry = this.#entries.get(key)
    if (!entry) return undefined

    this.#entries.delete(key)
    if (entry.expiresAt <= Date.now()) {
      this.#bytes -= entry.bytes
      return undefined
    }

    // Read last, so it goes last.
    this.#entries.set(key, entry)
    return entry.page
  }

  set(url: URL, page: CachedWebPage): void {
    const key = cacheKey(url)
    const bytes = page.body.byteLength + page.url.length + page.title.length + ENTRY_OVERHEAD_BYTES

    this.delete(key)
    if (bytes > MAX_BYTES) return

    this.#entries.set(key, { page, bytes, expiresAt: Date.now() + TTL_MS })
    this.#bytes += bytes

    for (const [oldest] of this.#entries) {
      if (this.#bytes <= MAX_BYTES) break
      this.delete(oldest)
    }
  }

  private delete(key: string): void {
    const entry = this.#entries.get(key)
    if (!entry) return

    this.#entries.delete(key)
    this.#bytes -= entry.bytes
  }
}

/** The URL as a server reads it: without its fragment. The URL parser already lowercases the host. */
function cacheKey(url: URL): string {
  const key = new URL(url.href)
  key.hash = ""
  return key.href
}
