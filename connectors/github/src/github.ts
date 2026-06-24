import type { RestClient } from "@sixb/connector-rest"
import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import type {
  CreateIssueInput,
  GitHubClient,
  GitHubConnectorOptions,
  GitHubIssue,
  GitHubPage,
  GitHubRepository,
  ListIssuesOptions,
  ListRepositoriesOptions,
  RepoTarget,
  UpdateIssueInput,
} from "./types"
import { githubEventsWebhook } from "./webhook"

const GITHUB_API_BASE = "https://api.github.com/"
const GITHUB_API_VERSION = "2022-11-28"

export type GitHubConnector = ConnectorAdapter<"github", GitHubClient>

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

/**
 * GitHub connector built on `@sixb/connector-rest`.
 *
 * Returns a typed client for repository and issue operations. When `onEvent`
 * is provided it also registers an inbound webhook that verifies GitHub's
 * signature and forwards every event to the handler.
 *
 * Register it from a project's `connectors/` directory:
 *
 * ```ts
 * export const githubConnector = defineConnector("github", github({
 *   token: process.env.GITHUB_TOKEN!,
 *   owner: "acme",
 *   repo: "web",
 * }))
 * ```
 */
export function github(options: GitHubConnectorOptions): GitHubConnector {
  assertNonEmpty(options.token, "token")

  const http = rest({
    baseUrl: options.baseUrl ?? GITHUB_API_BASE,
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    retry: { maxRetries: 2 },
  })

  return {
    type: "github",
    webhooks: options.onEvent
      ? [githubEventsWebhook({ secret: options.webhookSecret, onEvent: options.onEvent })]
      : undefined,
    async connect(context) {
      return createGitHubClient(await http.connect(context), options)
    },
  }
}

function createGitHubClient(http: RestClient, options: GitHubConnectorOptions): GitHubClient {
  const resolveRepo = (target?: RepoTarget): { owner: string; repo: string } => {
    const owner = target?.owner ?? options.owner
    const repo = target?.repo ?? options.repo
    if (!owner || !repo) {
      throw new Error(
        "[SixbGitHub] owner and repo are required — pass them in the call or set them on the connector."
      )
    }
    return { owner, repo }
  }

  const updateIssue = async (
    issueNumber: number,
    patch: UpdateIssueInput
  ): Promise<GitHubIssue> => {
    const { owner, repo } = resolveRepo(patch)
    const response = await http.request(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: patch.title,
        body: patch.body,
        state: patch.state,
        state_reason: patch.stateReason,
        labels: patch.labels,
        assignees: patch.assignees,
        milestone: patch.milestone,
      }),
    })
    return readJson<GitHubIssue>(response)
  }

  const client: GitHubClient = {
    async listRepositories(
      listOptions?: ListRepositoriesOptions
    ): Promise<GitHubPage<GitHubRepository>> {
      const params = new URLSearchParams()
      applyPaging(params, listOptions)
      if (listOptions?.affiliation) params.set("affiliation", listOptions.affiliation)
      if (listOptions?.visibility) params.set("visibility", listOptions.visibility)
      if (listOptions?.sort) params.set("sort", listOptions.sort)
      const base = listOptions?.org ? `/orgs/${listOptions.org}/repos` : "/user/repos"
      return readPage<GitHubRepository>(
        await http.get(resolvePagePath(withQuery(base, params), listOptions))
      )
    },

    iterRepositories(listOptions?: ListRepositoriesOptions): AsyncIterable<GitHubRepository> {
      return iteratePages((pageToken) => client.listRepositories({ ...listOptions, pageToken }))
    },

    async listIssues(listOptions?: ListIssuesOptions): Promise<GitHubPage<GitHubIssue>> {
      const { owner, repo } = resolveRepo(listOptions)
      const params = new URLSearchParams({ state: listOptions?.state ?? "open" })
      applyPaging(params, listOptions)
      if (listOptions?.labels?.length) params.set("labels", listOptions.labels.join(","))
      if (listOptions?.assignee) params.set("assignee", listOptions.assignee)
      if (listOptions?.since) params.set("since", listOptions.since)
      const path = withQuery(`/repos/${owner}/${repo}/issues`, params)
      const page = await readPage<GitHubIssue>(await http.get(resolvePagePath(path, listOptions)))
      // The issues endpoint also returns pull requests — drop them.
      return { ...page, items: page.items.filter((issue) => issue.pull_request === undefined) }
    },

    iterIssues(listOptions?: ListIssuesOptions): AsyncIterable<GitHubIssue> {
      return iteratePages((pageToken) => client.listIssues({ ...listOptions, pageToken }))
    },

    async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
      const { owner, repo } = resolveRepo(input)
      const response = await http.post(`/repos/${owner}/${repo}/issues`, {
        title: input.title,
        body: input.body,
        labels: input.labels,
        assignees: input.assignees,
        milestone: input.milestone,
      })
      return readJson<GitHubIssue>(response)
    },

    updateIssue,

    deleteIssue(issueNumber: number, target?: RepoTarget): Promise<GitHubIssue> {
      // GitHub's REST API cannot delete issues, so "delete" closes the issue.
      return updateIssue(issueNumber, { ...target, state: "closed", stateReason: "not_planned" })
    },
  }

  return client
}

function applyPaging(params: URLSearchParams, options?: { readonly pageSize?: number }): void {
  if (options?.pageSize !== undefined)
    params.set("per_page", String(assertPageSize(options.pageSize)))
}

function withQuery(base: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new GitHubApiError(response.status, await response.text().catch(() => ""))
  }
  return (await response.json()) as T
}

async function readPage<T>(response: Response): Promise<GitHubPage<T>> {
  const items = await readJson<T[]>(response)
  const links = parseLinkHeader(response.headers.get("link"))
  return {
    items,
    hasMore: links.next !== undefined,
    nextPageToken: links.next ? encodePageToken(links.next) : undefined,
    previousPageToken: links.prev ? encodePageToken(links.prev) : undefined,
  }
}

async function* iteratePages<T>(
  list: (pageToken?: string) => Promise<GitHubPage<T>>
): AsyncIterable<T> {
  for (let pageToken: string | undefined; ; ) {
    const page = await list(pageToken)
    yield* page.items
    if (!page.nextPageToken) return
    pageToken = page.nextPageToken
  }
}

function resolvePagePath(path: string, options?: { readonly pageToken?: string }): string {
  return options?.pageToken ? decodePageToken(options.pageToken) : path
}

function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {}
  for (const part of header?.split(",") ?? []) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/)
    if (match?.[1] && match[2]) links[match[2]] = match[1]
  }
  return links
}

function encodePageToken(url: string): string {
  return Buffer.from(url).toString("base64url")
}

function decodePageToken(token: string): string {
  try {
    return Buffer.from(token, "base64url").toString()
  } catch {
    throw new Error("[SixbGitHub] Invalid pageToken.")
  }
}

function assertPageSize(pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("[SixbGitHub] pageSize must be an integer from 1 to 100.")
  }
  return pageSize
}

function assertNonEmpty(value: string, field: string): void {
  if (!value?.trim()) {
    throw new Error(`[SixbGitHub] ${field} must not be empty.`)
  }
}
