import type { GitHubHttpContext } from "../http"
import { readContent } from "../http"
import type {
  GitHubAttachment,
  GitHubAttachmentSource,
  GitHubAttachmentsApi,
} from "../types/attachments"
import type { GitHubRequestOptions } from "../types/common"

// GitHub has no API for issue attachments. Their links live in the Markdown body:
//   images and videos  https://github.com/user-attachments/assets/<uuid>
//                      https://github.com/<owner>/<repo>/assets/<user id>/<uuid>        (2023)
//                      https://user-images.githubusercontent.com/<user id>/<id>-<uuid>.png  (older)
//   other files        https://github.com/user-attachments/files/<id>/<name>
//                      https://github.com/<owner>/<repo>/files/<id>/<name>               (older)
// In a private repository those links need a signed-in browser. The body's HTML rendering
// (`bodyFormat: "html"` or `"full"`) rewrites images and videos to
// https://private-user-images.githubusercontent.com/<user id>/<id>-<uuid>.<ext>?jwt=…, a link signed
// for a few minutes that downloads without credentials.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const ASSET_PATH = new RegExp(`^/user-attachments/assets/(${UUID})$`, "i")
const REPOSITORY_ASSET_PATH = new RegExp(`^/[^/]+/[^/]+/assets/\\d+/(${UUID})$`, "i")
const IMAGE_HOST_PATH = new RegExp(`^/\\d+/\\d+-(${UUID})\\.[a-z0-9]+$`, "i")
const FILE_PATH = /^\/user-attachments\/files\/(\d+)\/([^/]+)$/
const REPOSITORY_FILE_PATH = /^\/[^/]+\/[^/]+\/files\/(\d+)\/([^/]+)$/

const GITHUB_COM = "github.com"
const PUBLIC_IMAGE_HOST = "user-images.githubusercontent.com"
const PRIVATE_IMAGE_HOST = "private-user-images.githubusercontent.com"

// Anything that looks like a link; each one is then parsed and checked against the hosts above.
const LINK = /https:\/\/[^\s"'<>()[\]`]+/g

export function createGitHubAttachmentsApi(context: GitHubHttpContext): GitHubAttachmentsApi {
  const webHost = githubWebHost(context.apiBaseUrl)

  return {
    find(source: GitHubAttachmentSource): GitHubAttachment[] {
      const signed = signedLinks(source.body_html, webHost)
      const found = new Map<string, GitHubAttachment>()

      // The Markdown names attachments as written; the HTML adds any the Markdown lacks, as when
      // only `body_html` was requested.
      for (const text of [source.body, source.body_html]) {
        for (const link of links(text)) {
          const attachment = classify(link, webHost)
          if (!attachment || found.has(attachment.key)) continue
          found.set(attachment.key, {
            id: attachment.id,
            kind: attachment.kind,
            url: attachment.url,
            downloadUrl: signed.get(attachment.id.toLowerCase()) ?? attachment.url,
            ...(attachment.name ? { name: attachment.name } : {}),
          })
        }
      }

      return [...found.values()]
    },

    async download(
      attachment: Pick<GitHubAttachment, "downloadUrl">,
      options?: GitHubRequestOptions
    ): Promise<Response> {
      const url = parseLink(attachment.downloadUrl)
      if (!url || !classify(url, webHost)) {
        throw new Error(
          "[SixbGitHub] Refusing an attachment URL outside GitHub's attachment hosts."
        )
      }

      // Plain fetch, without the token: a signed link carries its own credential, and GitHub's
      // public links redirect to storage that would reject a second one.
      const response = await readContent(await fetch(url, { signal: options?.signal }))

      // A private repository's plain link leads to GitHub's sign-in page, not the file.
      if (response.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
        await response.body?.cancel()
        throw new Error(
          '[SixbGitHub] GitHub answered with a web page instead of the attachment. In a private repository, read the body with bodyFormat: "full" and pass body_html to find(), so it downloads from the signed link.'
        )
      }
      return response
    },
  }
}

interface ClassifiedLink {
  /** Deduplicates a signed link and the link it was rendered from. */
  readonly key: string
  readonly id: string
  readonly kind: "media" | "file"
  readonly url: string
  readonly name?: string
}

function classify(url: URL, webHost: string): ClassifiedLink | null {
  // The host includes any port, so a link matches only the configured host's own port.
  if (url.protocol !== "https:" || url.username || url.password) return null
  const path = url.pathname

  if (url.host === webHost) {
    const asset = path.match(ASSET_PATH) ?? path.match(REPOSITORY_ASSET_PATH)
    if (asset?.[1]) return media(asset[1], url)

    const file = path.match(FILE_PATH) ?? path.match(REPOSITORY_FILE_PATH)
    if (file?.[1] && file[2]) {
      return {
        key: `file:${file[1]}`,
        id: file[1],
        kind: "file",
        url: url.href,
        name: fileName(file[2]),
      }
    }
    return null
  }

  // GitHub's image hosts serve github.com attachments only, never an Enterprise Server's.
  if (webHost !== GITHUB_COM) return null
  if (url.host === PUBLIC_IMAGE_HOST || url.host === PRIVATE_IMAGE_HOST) {
    const image = path.match(IMAGE_HOST_PATH)
    if (image?.[1]) return media(image[1], url)
  }
  return null
}

function media(uuid: string, url: URL): ClassifiedLink {
  return {
    key: `media:${uuid.toLowerCase()}`,
    id: uuid.toLowerCase(),
    kind: "media",
    url: url.href,
  }
}

/** Signed links in the HTML, by asset UUID. */
function signedLinks(html: string | null | undefined, webHost: string): Map<string, string> {
  const signed = new Map<string, string>()
  for (const link of links(html)) {
    if (link.host !== PRIVATE_IMAGE_HOST || !link.searchParams.has("jwt")) continue
    const attachment = classify(link, webHost)
    if (attachment && !signed.has(attachment.id)) signed.set(attachment.id, link.href)
  }
  return signed
}

function* links(text: string | null | undefined): Generator<URL> {
  if (!text) return
  for (const match of text.matchAll(LINK)) {
    // HTML escapes `&` in attributes, and a link ending a sentence takes its punctuation.
    const url = parseLink(match[0].replaceAll("&amp;", "&").replace(/[.,;:!?]+$/, ""))
    if (url) yield url
  }
}

function parseLink(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function fileName(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * The web host serving attachments for the configured API: github.com for api.github.com,
 * `<name>.ghe.com` for GitHub Enterprise Cloud's `api.<name>.ghe.com`, and an Enterprise Server's
 * own host, port included.
 */
function githubWebHost(apiBaseUrl: URL): string {
  if (apiBaseUrl.host === "api.github.com") return GITHUB_COM
  if (apiBaseUrl.hostname.startsWith("api.") && apiBaseUrl.hostname.endsWith(".ghe.com")) {
    return apiBaseUrl.host.slice("api.".length)
  }
  return apiBaseUrl.host
}
