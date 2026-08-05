import type { RestClient } from "@sixb/connector-rest"
import type { GitHubPage, GitHubRepositoryTarget } from "./types/common"

export interface GitHubHttpContext {
  readonly http: RestClient
  readonly apiBaseUrl: URL
}

/** Raised when the GitHub REST API returns a non-2xx response. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`[SixbGitHub] GitHub API request failed with ${status}: ${body}`)
    this.name = "GitHubApiError"
  }
}

export function applyPaging(
  params: URLSearchParams,
  options?: { readonly pageSize?: number }
): void {
  if (options?.pageSize !== undefined)
    params.set("per_page", String(assertPageSize(options.pageSize)))
}

export function withQuery(base: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new GitHubApiError(response.status, await response.text().catch(() => ""))
  }
  return (await response.json()) as T
}

export async function readNoContent(response: Response): Promise<void> {
  if (!response.ok) {
    throw new GitHubApiError(response.status, await response.text().catch(() => ""))
  }
}

/** Read GitHub's 204/404 membership-check response as a boolean. */
export async function readPresence(response: Response): Promise<boolean> {
  if (response.status === 204) return true
  if (response.status === 404) return false
  throw new GitHubApiError(response.status, await response.text().catch(() => ""))
}

export async function readPage<T>(response: Response, apiBaseUrl: URL): Promise<GitHubPage<T>> {
  const items = await readJson<T[]>(response)
  const links = parseLinkHeader(response.headers.get("link"))
  return {
    items,
    hasMore: links.next !== undefined,
    nextPageToken: links.next ? encodePageToken(links.next, apiBaseUrl) : undefined,
    previousPageToken: links.prev ? encodePageToken(links.prev, apiBaseUrl) : undefined,
  }
}

export function resolvePagePath(path: string, options?: { readonly pageToken?: string }): string {
  return options?.pageToken ? decodePageToken(options.pageToken) : path
}

export function assertNonEmpty(value: string, field: string): void {
  if (!value?.trim()) {
    throw new Error(`[SixbGitHub] ${field} must not be empty.`)
  }
}

export function pathPart(value: string, field: string): string {
  assertNonEmpty(value, field)
  return encodeURIComponent(value)
}

export function pathId(value: number, field: string): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[SixbGitHub] ${field} must be a positive integer.`)
  }
  return String(value)
}

export function repositoryPath(target: GitHubRepositoryTarget): string {
  return `/repos/${pathPart(target.owner, "owner")}/${pathPart(target.repo, "repo")}`
}

function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {}
  for (const part of header?.split(",") ?? []) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/)
    if (match?.[1] && match[2]) links[match[2]] = match[1]
  }
  return links
}

function encodePageToken(url: string, apiBaseUrl: URL): string {
  const parsed = new URL(url)
  if (
    parsed.origin !== apiBaseUrl.origin ||
    !isPathWithinBase(parsed.pathname, apiBaseUrl.pathname)
  ) {
    throw new Error("[SixbGitHub] Refusing pagination URL outside the configured API base.")
  }

  return Buffer.from(`${parsed.pathname}${parsed.search}`).toString("base64url")
}

function decodePageToken(token: string): string {
  let path: string
  try {
    path = Buffer.from(token, "base64url").toString()
  } catch {
    throw new Error("[SixbGitHub] Invalid pageToken.")
  }

  if (!path.startsWith("/") || path.startsWith("//") || /^[a-z][a-z\d+\-.]*:/i.test(path)) {
    throw new Error("[SixbGitHub] Invalid pageToken.")
  }

  return path
}

function isPathWithinBase(pathname: string, basePathname: string): boolean {
  const normalizedBase = basePathname.endsWith("/") ? basePathname : `${basePathname}/`
  return normalizedBase === "/" || pathname === basePathname || pathname.startsWith(normalizedBase)
}

function assertPageSize(pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("[SixbGitHub] pageSize must be an integer from 1 to 100.")
  }
  return pageSize
}
