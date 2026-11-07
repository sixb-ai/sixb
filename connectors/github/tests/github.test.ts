import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { noopLogger } from "@sixb/core"
import type {
  GitHubClient,
  GitHubEventContext,
  GitHubIssueEvent,
  GitHubRepositoryScope,
} from "../src"
import { GitHubApiError, github, githubEventsWebhook } from "../src"

const CONTEXT = {
  projectId: "demo",
  connectorId: "github",
  signal: new AbortController().signal,
}

type VerifyCtx = Parameters<NonNullable<ReturnType<typeof githubEventsWebhook>["verify"]>>[0]
type HandleCtx = Parameters<ReturnType<typeof githubEventsWebhook>["handle"]>[0]

interface RecordedRequest {
  readonly url: URL
  readonly method: string
  readonly headers: Headers
  readonly body?: unknown
  /** The body as handed to fetch, for binary uploads. */
  readonly rawBody?: unknown
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Replaces fetch with a recorder; `respond` receives each request and its 1-based index. */
function record(
  respond: (request: RecordedRequest, index: number) => Response = () => json([])
): RecordedRequest[] {
  const calls: RecordedRequest[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      rawBody: init?.body,
    }
    calls.push(request)
    return respond(request, calls.length)
  }) as typeof fetch
  return calls
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

function nextLink(url: string): ResponseInit {
  return { headers: { link: `<${url}>; rel="next"` } }
}

function pageToken(path: string): string {
  return Buffer.from(path).toString("base64url")
}

const connect = (baseUrl?: string) => github({ token: "t", baseUrl }).connect(CONTEXT)
const webRepo = { owner: "acme", repo: "web" }

describe("github connector", () => {
  test("connects with GitHub auth headers and sends no paging params unless asked", async () => {
    const calls = record()

    const adapter = github({ token: "pat-123" })
    const client = await adapter.connect(CONTEXT)
    await client.repos.listForAuthenticatedUser()

    expect(adapter.type).toBe("github")
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer pat-123")
    expect(calls[0]?.headers.get("x-github-api-version")).toBe("2022-11-28")
    expect([...(calls[0]?.url.searchParams.keys() ?? [])]).toEqual([])
  })

  // The issue list includes a pull request because GitHub returns them from issue endpoints.
  const listItems = [
    { id: 1, number: 1, title: "bug" },
    { id: 2, number: 2, title: "pr", pull_request: { url: "x" } },
  ]

  test.each([
    [
      "repos.listForAuthenticatedUser",
      (client: GitHubClient) =>
        client.repos.listForAuthenticatedUser({
          visibility: "private",
          affiliation: ["owner", "collaborator"],
          sort: "updated",
          direction: "desc",
          since: "2026-01-01T00:00:00Z",
          before: "2026-02-01T00:00:00Z",
        }),
      "/user/repos",
      {
        visibility: "private",
        affiliation: "owner,collaborator",
        sort: "updated",
        direction: "desc",
        since: "2026-01-01T00:00:00Z",
        before: "2026-02-01T00:00:00Z",
      },
    ],
    [
      "org().repos.list",
      (client: GitHubClient) =>
        client.org("acme").repos.list({ type: "sources", sort: "full_name", direction: "asc" }),
      "/orgs/acme/repos",
      { type: "sources", sort: "full_name", direction: "asc" },
    ],
    [
      "issues.listForAuthenticatedUser",
      (client: GitHubClient) =>
        client.issues.listForAuthenticatedUser({
          filter: "created",
          state: "all",
          labels: ["bug", "ui"],
          sort: "updated",
          direction: "asc",
          since: "2026-01-01T00:00:00Z",
          collab: true,
          orgs: false,
          owned: true,
          pulls: false,
        }),
      "/issues",
      {
        filter: "created",
        state: "all",
        labels: "bug,ui",
        sort: "updated",
        direction: "asc",
        since: "2026-01-01T00:00:00Z",
        collab: "true",
        orgs: "false",
        owned: "true",
        pulls: "false",
      },
    ],
    [
      "org().issues.listForAuthenticatedUser",
      (client: GitHubClient) =>
        client.org("acme").issues.listForAuthenticatedUser({
          filter: "mentioned",
          state: "open",
          labels: ["bug"],
          type: "Incident",
          sort: "comments",
          direction: "desc",
          since: "2026-01-01T00:00:00Z",
        }),
      "/orgs/acme/issues",
      {
        filter: "mentioned",
        state: "open",
        labels: "bug",
        type: "Incident",
        sort: "comments",
        direction: "desc",
        since: "2026-01-01T00:00:00Z",
      },
    ],
    [
      "repo().issues.list",
      (client: GitHubClient) =>
        client.repo(webRepo).issues.list({
          milestone: "none",
          state: "all",
          assignee: "octocat",
          type: "Incident",
          creator: "mona",
          mentioned: "hubot",
          issueFieldValues: "priority:Urgent,severity:High",
          labels: ["bug", "ui"],
          sort: "comments",
          direction: "asc",
          since: "2026-01-01T00:00:00Z",
        }),
      "/repos/acme/web/issues",
      {
        milestone: "none",
        state: "all",
        assignee: "octocat",
        type: "Incident",
        creator: "mona",
        mentioned: "hubot",
        issue_field_values: "priority:Urgent,severity:High",
        labels: "bug,ui",
        sort: "comments",
        direction: "asc",
        since: "2026-01-01T00:00:00Z",
      },
    ],
    [
      "repo().issues.comments.list",
      (client: GitHubClient) =>
        client.repo(webRepo).issues.comments.list(7, {
          pageSize: 50,
          since: "2026-01-01T00:00:00Z",
        }),
      "/repos/acme/web/issues/7/comments",
      { per_page: "50", since: "2026-01-01T00:00:00Z" },
    ],
    [
      "repo().branches.list",
      (client: GitHubClient) =>
        client.repo(webRepo).branches.list({ protected: true, pageSize: 50 }),
      "/repos/acme/web/branches",
      { protected: "true", per_page: "50" },
    ],
    [
      "repo().branches.list unprotected",
      (client: GitHubClient) => client.repo(webRepo).branches.list({ protected: false }),
      "/repos/acme/web/branches",
      { protected: "false" },
    ],
    [
      "repo().releases.list",
      (client: GitHubClient) => client.repo(webRepo).releases.list({ pageSize: 50 }),
      "/repos/acme/web/releases",
      { per_page: "50" },
    ],
    [
      "repo().releases.assets.list",
      (client: GitHubClient) => client.repo(webRepo).releases.assets.list(7, { pageSize: 50 }),
      "/repos/acme/web/releases/7/assets",
      { per_page: "50" },
    ],
    [
      "repo().releases.reactions.list",
      (client: GitHubClient) =>
        client.repo(webRepo).releases.reactions.list(7, { content: "rocket", pageSize: 50 }),
      "/repos/acme/web/releases/7/reactions",
      { content: "rocket", per_page: "50" },
    ],
    [
      "repo().pulls.list",
      (client: GitHubClient) =>
        client.repo(webRepo).pulls.list({
          state: "closed",
          head: "acme:feature/login",
          base: "main",
          sort: "long-running",
          direction: "asc",
          pageSize: 50,
        }),
      "/repos/acme/web/pulls",
      {
        state: "closed",
        head: "acme:feature/login",
        base: "main",
        sort: "long-running",
        direction: "asc",
        per_page: "50",
      },
    ],
    [
      "repo().pulls.list unfiltered",
      (client: GitHubClient) => client.repo(webRepo).pulls.list(),
      "/repos/acme/web/pulls",
      {},
    ],
    [
      "repo().pulls.reviews.list",
      (client: GitHubClient) => client.repo(webRepo).pulls.reviews.list(12, { pageSize: 50 }),
      "/repos/acme/web/pulls/12/reviews",
      { per_page: "50" },
    ],
    [
      "repo().stacks.list for one pull request",
      (client: GitHubClient) =>
        client.repo(webRepo).stacks.list({ pullRequest: 1086, pageSize: 50 }),
      "/repos/acme/web/stacks",
      { pull_request: "1086", per_page: "50" },
    ],
    [
      "repo().stacks.list unfiltered",
      (client: GitHubClient) => client.repo(webRepo).stacks.list(),
      "/repos/acme/web/stacks",
      {},
    ],
    [
      "repo().commits.list",
      (client: GitHubClient) =>
        client.repo(webRepo).commits.list({
          sha: "release/1.0",
          path: "src/app.ts",
          author: "mona",
          committer: "hubot",
          since: "2026-10-01T00:00:00Z",
          until: "2026-11-01T00:00:00Z",
          pageSize: 50,
        }),
      "/repos/acme/web/commits",
      {
        sha: "release/1.0",
        path: "src/app.ts",
        author: "mona",
        committer: "hubot",
        since: "2026-10-01T00:00:00Z",
        until: "2026-11-01T00:00:00Z",
        per_page: "50",
      },
    ],
    [
      "repo().commits.list unfiltered",
      (client: GitHubClient) => client.repo(webRepo).commits.list(),
      "/repos/acme/web/commits",
      {},
    ],
  ] as const)("%s maps its filters and returns GitHub's items", async (_name, list, path, query) => {
    const calls = record(() => json(listItems))
    const client = await connect()

    const page = await list(client)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url.pathname).toBe(path)
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual(query)
    expect(page.items).toEqual(listItems as never)
  })

  type RequestCase = readonly [
    name: string,
    run: (client: GitHubClient) => Promise<unknown>,
    method: string,
    path: string,
    body: unknown,
  ]
  const requests: readonly RequestCase[] = [
    ["repo().get", (c) => c.repo(webRepo).get(), "GET", "/repos/acme/web", undefined],
    [
      "repo().issues.get",
      (c) => c.repo(webRepo).issues.get(7),
      "GET",
      "/repos/acme/web/issues/7",
      undefined,
    ],
    [
      "repo().issues.create",
      (c) =>
        c.repo(webRepo).issues.create({
          title: "Bug",
          labels: ["triage"],
          issueFieldValues: [{ fieldId: 42, value: ["High"] }],
          type: "Incident",
        }),
      "POST",
      "/repos/acme/web/issues",
      {
        title: "Bug",
        labels: ["triage"],
        issue_field_values: [{ field_id: 42, value: ["High"] }],
        type: "Incident",
      },
    ],
    [
      "repo().issues.update",
      (c) => c.repo(webRepo).issues.update(7, { title: "Renamed", stateReason: "reopened" }),
      "PATCH",
      "/repos/acme/web/issues/7",
      { title: "Renamed", state_reason: "reopened" },
    ],
    [
      "repo().issues.comments.create",
      (c) => c.repo(webRepo).issues.comments.create(7, { body: "Me too" }),
      "POST",
      "/repos/acme/web/issues/7/comments",
      { body: "Me too" },
    ],
    [
      "repo().issues.comments.get",
      (c) => c.repo(webRepo).issues.comments.get(99),
      "GET",
      "/repos/acme/web/issues/comments/99",
      undefined,
    ],
    [
      "repo().issues.comments.update",
      (c) => c.repo(webRepo).issues.comments.update(99, { body: "Updated" }),
      "PATCH",
      "/repos/acme/web/issues/comments/99",
      { body: "Updated" },
    ],
    [
      "repo().issues.comments.delete",
      (c) => c.repo(webRepo).issues.comments.delete(99),
      "DELETE",
      "/repos/acme/web/issues/comments/99",
      undefined,
    ],
    [
      "repo().branches.get",
      (c) => c.repo(webRepo).branches.get("feature/login"),
      "GET",
      "/repos/acme/web/branches/feature%2Flogin",
      undefined,
    ],
    [
      "repo().pulls.get",
      (c) => c.repo(webRepo).pulls.get(12),
      "GET",
      "/repos/acme/web/pulls/12",
      undefined,
    ],
    [
      "repo().stacks.get",
      (c) => c.repo(webRepo).stacks.get(1085),
      "GET",
      "/repos/acme/web/stacks/1085",
      undefined,
    ],
    [
      "repo().commits.get by SHA",
      (c) => c.repo(webRepo).commits.get("6dcb09b5b57875f334f61aebed695e2e4193db5e"),
      "GET",
      "/repos/acme/web/commits/6dcb09b5b57875f334f61aebed695e2e4193db5e",
      undefined,
    ],
    // Reproduce: build the commit path with the raw ref instead of `pathPart`; the slash then
    // splits it into two segments.
    [
      "repo().commits.get by branch",
      (c) => c.repo(webRepo).commits.get("release/1.0"),
      "GET",
      "/repos/acme/web/commits/release%2F1.0",
      undefined,
    ],
    [
      "repo().releases.getByTag",
      (c) => c.repo(webRepo).releases.getByTag("@sixb/core@0.1.5"),
      "GET",
      "/repos/acme/web/releases/tags/%40sixb%2Fcore%400.1.5",
      undefined,
    ],
    [
      "repo().releases.get",
      (c) => c.repo(webRepo).releases.get(7),
      "GET",
      "/repos/acme/web/releases/7",
      undefined,
    ],
    [
      "repo().releases.getLatest",
      (c) => c.repo(webRepo).releases.getLatest(),
      "GET",
      "/repos/acme/web/releases/latest",
      undefined,
    ],
    [
      "repo().releases.create",
      (c) =>
        c.repo(webRepo).releases.create({
          tagName: "v1.0.0",
          targetCommitish: "main",
          draft: true,
          generateReleaseNotes: true,
          makeLatest: false,
        }),
      "POST",
      "/repos/acme/web/releases",
      {
        tag_name: "v1.0.0",
        target_commitish: "main",
        draft: true,
        generate_release_notes: true,
        make_latest: "false",
      },
    ],
    [
      "repo().releases.update",
      (c) =>
        c.repo(webRepo).releases.update(7, {
          name: "1.0.0",
          draft: false,
          discussionCategoryName: "Announcements",
          makeLatest: "legacy",
        }),
      "PATCH",
      "/repos/acme/web/releases/7",
      {
        name: "1.0.0",
        draft: false,
        discussion_category_name: "Announcements",
        make_latest: "legacy",
      },
    ],
    [
      "repo().releases.delete",
      (c) => c.repo(webRepo).releases.delete(7),
      "DELETE",
      "/repos/acme/web/releases/7",
      undefined,
    ],
    [
      "repo().releases.generateNotes",
      (c) =>
        c.repo(webRepo).releases.generateNotes({ tagName: "v1.1.0", previousTagName: "v1.0.0" }),
      "POST",
      "/repos/acme/web/releases/generate-notes",
      { tag_name: "v1.1.0", previous_tag_name: "v1.0.0" },
    ],
    [
      "repo().releases.assets.get",
      (c) => c.repo(webRepo).releases.assets.get(99),
      "GET",
      "/repos/acme/web/releases/assets/99",
      undefined,
    ],
    [
      "repo().releases.assets.update",
      (c) => c.repo(webRepo).releases.assets.update(99, { label: "macOS build" }),
      "PATCH",
      "/repos/acme/web/releases/assets/99",
      { label: "macOS build" },
    ],
    [
      "repo().releases.assets.delete",
      (c) => c.repo(webRepo).releases.assets.delete(99),
      "DELETE",
      "/repos/acme/web/releases/assets/99",
      undefined,
    ],
    [
      "repo().releases.reactions.create",
      (c) => c.repo(webRepo).releases.reactions.create(7, { content: "heart" }),
      "POST",
      "/repos/acme/web/releases/7/reactions",
      { content: "heart" },
    ],
    [
      "repo().releases.reactions.delete",
      (c) => c.repo(webRepo).releases.reactions.delete(7, 5),
      "DELETE",
      "/repos/acme/web/releases/7/reactions/5",
      undefined,
    ],
  ]

  test.each(requests)("%s sends its documented request", async (_name, run, method, path, body) => {
    // DELETE answers 204 and resolves to nothing; every other call decodes GitHub's JSON.
    const resource = method === "DELETE" ? undefined : { id: 99, number: 7, name: "web" }
    const calls = record(() => (resource ? json(resource) : new Response(null, { status: 204 })))
    const client = await connect()

    const result = await run(client)

    expect(calls).toHaveLength(1)
    expect([calls[0]?.method, calls[0]?.url.pathname]).toEqual([method, path])
    expect(calls[0]?.body).toEqual(body)
    expect(result).toEqual(resource)
  })

  test("follows the pageToken encoded from GitHub's Link header", async () => {
    const calls = record((_, index) =>
      json(
        [{ id: index, name: `repo-${index}` }],
        index === 1 ? nextLink("https://api.github.com/user/repos?per_page=1&page=2") : undefined
      )
    )
    const client = await connect()

    const first = await client.repos.listForAuthenticatedUser({ pageSize: 1 })
    const second = await client.repos.listForAuthenticatedUser({ pageToken: first.nextPageToken })

    expect(calls[0]?.url.searchParams.get("per_page")).toBe("1")
    expect(first).toMatchObject({ items: [{ id: 1 }], hasMore: true })
    expect(calls[1]?.url.searchParams.get("page")).toBe("2")
    expect(second).toMatchObject({ items: [{ id: 2 }], hasMore: false, nextPageToken: undefined })
  })

  test("follows a branch page's next link with its protected filter", async () => {
    const calls = record((_, index) =>
      json(
        [{ name: `release/${index}`, commit: { sha: `sha-${index}`, url: "x" }, protected: true }],
        index === 1
          ? nextLink("https://api.github.com/repos/acme/web/branches?protected=true&page=2")
          : undefined
      )
    )
    const branches = (await connect()).repo(webRepo).branches

    const first = await branches.list({ protected: true })
    const second = await branches.list({ pageToken: first.nextPageToken })

    expect(first).toMatchObject({ items: [{ name: "release/1" }], hasMore: true })
    expect(calls[1]?.url.pathname).toBe("/repos/acme/web/branches")
    expect(Object.fromEntries(calls[1]?.url.searchParams ?? [])).toEqual({
      protected: "true",
      page: "2",
    })
    expect(second).toMatchObject({ items: [{ name: "release/2" }], hasMore: false })
  })

  test("follows a commit page's next link with its filters", async () => {
    const calls = record((_, index) =>
      json(
        [{ sha: `sha-${index}` }],
        index === 1
          ? nextLink(
              "https://api.github.com/repos/acme/web/commits?sha=main&since=2026-10-01T00%3A00%3A00Z&page=2"
            )
          : undefined
      )
    )
    const commits = (await connect()).repo(webRepo).commits

    const first = await commits.list({ sha: "main", since: "2026-10-01T00:00:00Z" })
    const second = await commits.list({ pageToken: first.nextPageToken })

    expect(first).toMatchObject({ items: [{ sha: "sha-1" }], hasMore: true })
    expect(calls[1]?.url.pathname).toBe("/repos/acme/web/commits")
    expect(Object.fromEntries(calls[1]?.url.searchParams ?? [])).toEqual({
      sha: "main",
      since: "2026-10-01T00:00:00Z",
      page: "2",
    })
    expect(second).toMatchObject({ items: [{ sha: "sha-2" }], hasMore: false })
  })

  test("rejects caller-provided pageTokens that decode to absolute URLs", async () => {
    const calls = record()
    const client = await connect()

    await expect(
      client.repos.listForAuthenticatedUser({
        pageToken: pageToken("https://evil.example/repos?page=2"),
      })
    ).rejects.toThrow("Invalid pageToken")

    expect(calls).toHaveLength(0)
  })

  test("rejects pagination Link URLs outside the configured API base", async () => {
    const calls = record(() =>
      json([{ id: 1, name: "one" }], nextLink("https://evil.example/user/repos?page=2"))
    )
    const client = await connect()

    await expect(client.repos.listForAuthenticatedUser()).rejects.toThrow(
      "Refusing pagination URL outside the configured API base"
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url.origin).toBe("https://api.github.com")
  })

  test("keeps trusted pageToken paths within a configured API base path", async () => {
    const calls = record((_, index) =>
      json(
        [{ id: index, name: `repo-${index}` }],
        index === 1 ? nextLink("https://ghe.example.com/api/v3/user/repos?page=2") : undefined
      )
    )
    const client = await connect("https://ghe.example.com/api/v3/")

    const first = await client.repos.listForAuthenticatedUser()
    await client.repos.listForAuthenticatedUser({ pageToken: first.nextPageToken })

    expect(calls[1]?.url.pathname).toBe("/api/v3/user/repos")
  })

  // Shapes as GitHub returned them for sixb-ai/sixb's stack #1085, trimmed to the fields read.
  test("reads where a pull request sits in its stack, and the stack's pull requests from the bottom up", async () => {
    const stack = {
      id: 3203111,
      number: 1085,
      base: { ref: "main", sha: "abae626" },
      size: 5,
      position: 5,
    }
    const branch = (ref: string) => ({
      ref,
      sha: `${ref}-sha`,
      repo: { id: 1, name: "web", url: "https://api.github.com/repos/acme/web" },
    })
    record((request) => {
      if (request.url.pathname.endsWith("/pulls")) {
        return json([
          { number: 1087, title: "Standalone" },
          { number: 1086, title: "Top of the stack", stack },
        ])
      }
      return json({
        id: 3203111,
        node_id: "PRS_1",
        number: 1085,
        url: "https://api.github.com/repos/acme/web/stacks/1085",
        base: { ref: "main" },
        open: true,
        created_at: "2026-11-07T20:50:28Z",
        pull_requests: [
          {
            number: 1081,
            title: "Examples",
            state: "open",
            draft: true,
            merged_at: null,
            base: branch("main"),
            head: branch("examples-upgrades"),
          },
          {
            number: 1086,
            title: "Launch",
            state: "open",
            draft: false,
            merged_at: null,
            base: branch("phone/shell"),
            head: branch("phone/launch"),
          },
        ],
      })
    })
    const repo = (await connect()).repo(webRepo)

    const page = await repo.pulls.list()
    const [standalone, stacked] = page.items
    const detail = await repo.stacks.get(stacked!.stack!.number)

    expect(standalone?.stack).toBeUndefined()
    expect(stacked?.stack).toEqual(stack)
    expect(
      detail.pull_requests.map(({ number, base, head }) => [number, base.ref, head.ref])
    ).toEqual([
      [1081, "main", "examples-upgrades"],
      [1086, "phone/shell", "phone/launch"],
    ])
  })

  test("rejects invalid issue, pull and comment ids, release tags, branch names and commit refs before requesting", async () => {
    const calls = record()
    const { branches, commits, issues, pulls, releases, stacks } = (await connect()).repo(webRepo)

    await expect(branches.get(" ")).rejects.toThrow("branch must not be empty")
    await expect(commits.get(" ")).rejects.toThrow("ref must not be empty")
    await expect(pulls.get(0)).rejects.toThrow("pullNumber must be a positive integer")
    await expect(pulls.get(1.5)).rejects.toThrow("pullNumber must be a positive integer")
    await expect(pulls.reviews.list(0)).rejects.toThrow("pullNumber must be a positive integer")
    // Reproduce: set `pull_request` from the raw option in resources/stacks.ts.
    await expect(stacks.list({ pullRequest: 0 })).rejects.toThrow(
      "pullRequest must be a positive integer"
    )
    await expect(stacks.get(1.5)).rejects.toThrow("stackNumber must be a positive integer")
    await expect(issues.get(0)).rejects.toThrow("issueNumber must be a positive integer")
    await expect(issues.comments.list(0)).rejects.toThrow("issueNumber must be a positive integer")
    await expect(issues.comments.get(0)).rejects.toThrow("commentId must be a positive integer")
    await expect(releases.getByTag(" ")).rejects.toThrow("tag must not be empty")
    await expect(releases.get(0)).rejects.toThrow("releaseId must be a positive integer")
    await expect(releases.assets.list(0)).rejects.toThrow("releaseId must be a positive integer")
    await expect(releases.assets.get(0)).rejects.toThrow("assetId must be a positive integer")
    await expect(releases.reactions.delete(7, 0)).rejects.toThrow(
      "reactionId must be a positive integer"
    )

    expect(calls).toHaveLength(0)
  })

  const pullAndCommitCalls: readonly (readonly [
    name: string,
    run: (repo: GitHubRepositoryScope, signal: AbortSignal) => Promise<unknown>,
  ])[] = [
    ["pulls.list", (r, signal) => r.pulls.list({ signal })],
    ["pulls.get", (r, signal) => r.pulls.get(12, { signal })],
    ["pulls.reviews.list", (r, signal) => r.pulls.reviews.list(12, { signal })],
    ["stacks.list", (r, signal) => r.stacks.list({ signal })],
    ["stacks.get", (r, signal) => r.stacks.get(1085, { signal })],
    ["commits.list", (r, signal) => r.commits.list({ signal })],
    ["commits.get", (r, signal) => r.commits.get("main", { signal })],
  ]

  // Reproduce: drop `signal` from one method's request init in resources/pulls.ts or
  // resources/commits.ts; its row then reaches fetch and resolves.
  test.each(pullAndCommitCalls)("%s forwards the caller's signal", async (_name, run) => {
    const calls = record(() => json({}))
    const repo = (await connect()).repo(webRepo)

    const error: unknown = await run(repo, AbortSignal.abort()).catch((caught) => caught)

    expect(error).toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
  })

  const upload = {
    upload_url: "https://uploads.github.com/repos/acme/web/releases/7/assets{?name,label}",
  }
  const releaseCalls: readonly (readonly [
    name: string,
    run: (releases: GitHubRepositoryScope["releases"], signal: AbortSignal) => Promise<unknown>,
  ])[] = [
    ["list", (r, signal) => r.list({ signal })],
    ["get", (r, signal) => r.get(7, { signal })],
    ["getLatest", (r, signal) => r.getLatest({ signal })],
    ["getByTag", (r, signal) => r.getByTag("v1", { signal })],
    ["create", (r, signal) => r.create({ tagName: "v1" }, { signal })],
    ["update", (r, signal) => r.update(7, { name: "v1" }, { signal })],
    ["delete", (r, signal) => r.delete(7, { signal })],
    ["generateNotes", (r, signal) => r.generateNotes({ tagName: "v1" }, { signal })],
    ["assets.list", (r, signal) => r.assets.list(7, { signal })],
    ["assets.get", (r, signal) => r.assets.get(99, { signal })],
    [
      "assets.upload",
      (r, signal) => r.assets.upload(upload, { name: "a", data: new Uint8Array() }, { signal }),
    ],
    ["assets.update", (r, signal) => r.assets.update(99, { label: "a" }, { signal })],
    ["assets.delete", (r, signal) => r.assets.delete(99, { signal })],
    ["assets.download", (r, signal) => r.assets.download(99, { signal })],
    ["reactions.list", (r, signal) => r.reactions.list(7, { signal })],
    ["reactions.create", (r, signal) => r.reactions.create(7, { content: "+1" }, { signal })],
    ["reactions.delete", (r, signal) => r.reactions.delete(7, 5, { signal })],
  ]

  // Reproduce: drop `signal` from one method's request init in resources/releases.ts; its row
  // then reaches fetch and resolves.
  test.each(releaseCalls)("releases.%s forwards the caller's signal", async (_name, run) => {
    const calls = record(() => json({}))
    const releases = (await connect()).repo(webRepo).releases

    const error: unknown = await run(releases, AbortSignal.abort()).catch((caught) => caught)

    expect(error).toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
  })

  test("uploads a release asset to the release's upload URL", async () => {
    const calls = record(() => json({ id: 1, name: "app.zip" }, { status: 201 }))
    const assets = (await connect()).repo(webRepo).releases.assets
    const data = new Uint8Array([1, 2, 3])

    const asset = await assets.upload(upload, { name: "app.zip", label: "App", data })
    await assets.upload(upload, {
      name: "notes.txt",
      data: new Blob(["hi"], { type: "application/zip" }),
    })

    expect(calls[0]?.url.href).toBe(
      "https://uploads.github.com/repos/acme/web/releases/7/assets?name=app.zip&label=App"
    )
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.headers.get("content-type")).toBe("application/octet-stream")
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer t")
    expect(calls[0]?.rawBody).toBe(data)
    expect(calls[1]?.headers.get("content-type")).toBe("application/zip")
    expect(asset).toEqual({ id: 1, name: "app.zip" } as never)
  })

  // Reproduce: fetch the redirect through `context.http.get` instead of plain fetch; the second
  // request then carries the token.
  test("downloads an asset from GitHub's storage redirect without the token", async () => {
    const storage = "https://objects.githubusercontent.com/assets/99?sig=abc"
    const calls = record((_, index) =>
      index === 1
        ? new Response(null, { status: 302, headers: { location: storage } })
        : new Response(new Uint8Array([1, 2, 3]))
    )
    const assets = (await connect()).repo(webRepo).releases.assets

    const response = await assets.download(99)

    expect(calls[0]?.url.pathname).toBe("/repos/acme/web/releases/assets/99")
    expect(calls[0]?.headers.get("accept")).toBe("application/octet-stream")
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer t")
    expect(calls[1]?.url.href).toBe(storage)
    expect(calls[1]?.headers.get("authorization")).toBeNull()
    expect([...(await response.bytes())]).toEqual([1, 2, 3])
  })

  test("downloads an asset GitHub serves directly, and throws on a refused download", async () => {
    const calls = record((_, index) =>
      index === 1 ? new Response("bytes") : new Response("expired", { status: 403 })
    )
    const assets = (await connect()).repo(webRepo).releases.assets

    const direct = await assets.download(99)
    const refused: unknown = await assets.download(99).catch((caught) => caught)

    expect(calls).toHaveLength(2)
    expect(await direct.text()).toBe("bytes")
    expect(refused).toBeInstanceOf(GitHubApiError)
    expect(refused).toMatchObject({ status: 403 })
  })

  test("uploads only to the configured GitHub host", async () => {
    const calls = record(() => json({ id: 1 }))
    const data = new Uint8Array()
    const githubAssets = (await connect()).repo(webRepo).releases.assets
    const enterpriseAssets = (await connect("https://ghe.example.com/api/v3/")).repo(webRepo)
      .releases.assets

    const foreign = { upload_url: "https://evil.example/upload{?name,label}" }
    const enterprise = {
      upload_url:
        "https://ghe.example.com/api/uploads/repos/acme/web/releases/7/assets{?name,label}",
    }

    await expect(githubAssets.upload(foreign, { name: "a", data })).rejects.toThrow(
      "Refusing upload URL outside the configured GitHub host"
    )
    await expect(enterpriseAssets.upload(upload, { name: "a", data })).rejects.toThrow(
      "Refusing upload URL outside the configured GitHub host"
    )
    await enterpriseAssets.upload(enterprise, { name: "a", data })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url.pathname).toBe("/api/uploads/repos/acme/web/releases/7/assets")
  })

  test("asks GitHub for an issue's, pull request's or comment's body in the requested format", async () => {
    const calls = record((request) =>
      /\/(comments|issues|pulls)$/.test(request.url.pathname) ? json([]) : json({ id: 1 })
    )
    const client = await connect()
    const issues = client.repo(webRepo).issues

    await issues.get(5)
    await issues.get(5, { bodyFormat: "full" })
    await issues.list({ bodyFormat: "html" })
    await issues.comments.list(5, { bodyFormat: "text" })
    await issues.comments.get(9, { bodyFormat: "full" })
    await client.repo(webRepo).pulls.list({ bodyFormat: "html" })
    await client.repo(webRepo).pulls.get(12, { bodyFormat: "full" })
    const invalid: unknown = await issues
      .get(5, { bodyFormat: "markdown" as never })
      .catch((caught) => caught)

    expect(calls.map(({ headers }) => headers.get("accept"))).toEqual([
      "application/vnd.github+json",
      "application/vnd.github.full+json",
      "application/vnd.github.html+json",
      "application/vnd.github.text+json",
      "application/vnd.github.full+json",
      "application/vnd.github.html+json",
      "application/vnd.github.full+json",
    ])
    expect((invalid as Error).message).toContain("bodyFormat must be one of")
  })

  describe("attachments", () => {
    const image = "1f11b016-6048-41fa-b313-5243b18d1399"
    const video = "b4950445-beaf-455b-9464-7cb66ebc63a8"
    const legacy = "ec748ba6-c002-4ee2-bd01-c66d510f2666"
    const signedImage = `https://private-user-images.githubusercontent.com/20358651/663688738-${image}.png?jwt=eyJ.sig&amp;x=1`

    test("finds each image, video and file a body links to, once and in order", async () => {
      const attachments = (await connect()).attachments

      const found = attachments.find({
        body: [
          `<img width="846" alt="Image" src="https://github.com/user-attachments/assets/${image}" />`,
          "",
          `https://github.com/user-attachments/assets/${video}`,
          "",
          `![old](https://github.com/acme/web/assets/20358651/${legacy}) and again https://github.com/user-attachments/assets/${image}.`,
          "[report.pdf](https://github.com/user-attachments/files/17923/report%20Q3.pdf)",
          "Not attachments: https://github.com/acme/web/issues/3 https://evil.example/user-attachments/assets/" +
            image +
            " https://github.com.evil.example/user-attachments/assets/" +
            image,
        ].join("\n"),
      })

      expect(found).toEqual([
        {
          id: image,
          kind: "media",
          url: `https://github.com/user-attachments/assets/${image}`,
          downloadUrl: `https://github.com/user-attachments/assets/${image}`,
        },
        {
          id: video,
          kind: "media",
          url: `https://github.com/user-attachments/assets/${video}`,
          downloadUrl: `https://github.com/user-attachments/assets/${video}`,
        },
        {
          id: legacy,
          kind: "media",
          url: `https://github.com/acme/web/assets/20358651/${legacy}`,
          downloadUrl: `https://github.com/acme/web/assets/20358651/${legacy}`,
        },
        {
          id: "17923",
          kind: "file",
          url: "https://github.com/user-attachments/files/17923/report%20Q3.pdf",
          downloadUrl: "https://github.com/user-attachments/files/17923/report%20Q3.pdf",
          name: "report Q3.pdf",
        },
      ])
    })

    test("downloads private media from the signed link in the body's HTML", async () => {
      const attachments = (await connect()).attachments

      const found = attachments.find({
        body: `![shot](https://github.com/user-attachments/assets/${image})`,
        body_html: `<p><a href="${signedImage}"><img src="${signedImage}" alt="shot"></a></p>`,
      })
      // Only the HTML was requested: its signed links are the attachments.
      const htmlOnly = attachments.find({ body_html: `<img src="${signedImage}">` })

      const signed = signedImage.replace("&amp;", "&")
      expect(found).toEqual([
        {
          id: image,
          kind: "media",
          url: `https://github.com/user-attachments/assets/${image}`,
          downloadUrl: signed,
        },
      ])
      expect(htmlOnly).toEqual([{ id: image, kind: "media", url: signed, downloadUrl: signed }])
    })

    // Reproduce: download through `context.http.get`; the request then carries the token.
    test("downloads an attachment without the token", async () => {
      const calls = record(() => new Response(new Uint8Array([1, 2, 3])))
      const attachments = (await connect()).attachments

      const response = await attachments.download({
        downloadUrl: signedImage.replace("&amp;", "&"),
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.url.host).toBe("private-user-images.githubusercontent.com")
      expect(calls[0]?.url.searchParams.get("jwt")).toBe("eyJ.sig")
      expect(calls[0]?.headers.get("authorization")).toBeNull()
      expect([...(await response.bytes())]).toEqual([1, 2, 3])
    })

    test("refuses links outside GitHub's attachment hosts, and throws on a refused download", async () => {
      const calls = record(() => new Response("Not Found", { status: 404 }))
      const attachments = (await connect()).attachments

      const foreign: unknown = await attachments
        .download({ downloadUrl: `https://evil.example/user-attachments/assets/${image}` })
        .catch((caught) => caught)
      const issuePage: unknown = await attachments
        .download({ downloadUrl: "https://github.com/acme/web/issues/3" })
        .catch((caught) => caught)
      expect(calls).toHaveLength(0)

      const refused: unknown = await attachments
        .download({ downloadUrl: `https://github.com/user-attachments/assets/${image}` })
        .catch((caught) => caught)

      expect((foreign as Error).message).toContain("Refusing an attachment URL")
      expect((issuePage as Error).message).toContain("Refusing an attachment URL")
      expect(refused).toBeInstanceOf(GitHubApiError)
      expect(refused).toMatchObject({ status: 404 })
    })

    test("finds an Enterprise Server's attachments on its own host only", async () => {
      const attachments = (await connect("https://ghe.example.com/api/v3/")).attachments

      const found = attachments.find({
        body: [
          `https://ghe.example.com/user-attachments/assets/${image}`,
          `https://github.com/user-attachments/assets/${video}`,
          `https://user-images.githubusercontent.com/1/2-${legacy}.png`,
        ].join("\n"),
      })

      expect(found.map(({ id }) => id)).toEqual([image])
    })
  })

  test("throws GitHubApiError on non-2xx responses", async () => {
    record(() => json({ message: "Not Found" }, { status: 404 }))
    const client = await connect()

    const error: unknown = await client
      .repo(webRepo)
      .issues.create({ title: "x" })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error).toMatchObject({ status: 404 })
    expect((error as Error).message).toContain("Not Found")
  })

  describe("events webhook", () => {
    const sign = (secret: string, body: string): string =>
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

    test("registers only when onEvent is set", () => {
      expect(github({ token: "t" }).webhooks).toBeUndefined()
      expect(
        github({ token: "t", webhookAllowUnverified: true, onEvent: () => {} }).webhooks
      ).toHaveLength(1)
    })

    test("verifies the signature and forwards the typed event + runtime to onEvent", async () => {
      const received: GitHubEventContext[] = []
      const webhook = githubEventsWebhook({
        credential: "shh",
        onEvent: (context) => {
          received.push(context)
        },
      })
      const body = JSON.stringify({ action: "opened", issue: { number: 1, title: "Bug" } })
      const sixb = { id: "demo" }
      const client = () => Promise.resolve({} as never)

      webhook.verify?.({
        request: new Request("https://x/hook", {
          method: "POST",
          headers: { "x-hub-signature-256": sign("shh", body) },
        }),
        rawBody: new TextEncoder().encode(body),
      } as unknown as VerifyCtx)

      await webhook.handle({
        request: new Request("https://x/hook", {
          method: "POST",
          headers: { "x-github-event": "issues", "x-github-delivery": "d-1" },
        }),
        body: JSON.parse(body),
        sixb,
        logger: noopLogger,
        client,
      } as unknown as HandleCtx)

      expect(received).toHaveLength(1)
      const event = received[0]!.event
      expect(event.deliveryId).toBe("d-1")
      // Narrowing on the event name types the payload: these lines stop compiling if it does not.
      if (event.name !== "issues") throw new Error(`Expected an issues event, got ${event.name}`)
      const action: GitHubIssueEvent["action"] = event.action
      const issueNumber: number = event.payload.issue.number
      expect(action).toBe("opened")
      expect(issueNumber).toBe(1)
      // The live runtime and client resolver are passed straight through.
      expect(received[0]?.sixb).toBe(sixb as never)
      expect(received[0]?.logger).toBe(noopLogger)
      expect(received[0]?.client).toBe(client)
    })

    test("rejects an invalid signature", () => {
      const webhook = githubEventsWebhook({ credential: "shh", onEvent: () => {} })
      expect(() =>
        webhook.verify?.({
          request: new Request("https://x/hook", {
            method: "POST",
            headers: { "x-hub-signature-256": "sha256=deadbeef" },
          }),
          rawBody: new TextEncoder().encode("{}"),
        } as unknown as VerifyCtx)
      ).toThrow("Invalid webhook signature")
    })

    test("ignores deliveries without an event header", async () => {
      let called = false
      const webhook = githubEventsWebhook({
        allowUnverified: true,
        onEvent: () => {
          called = true
        },
      })

      await webhook.handle({
        request: new Request("https://x/hook", { method: "POST" }),
        body: { zen: "Keep it simple." },
      } as unknown as HandleCtx)

      expect(called).toBe(false)
    })
  })
})

describe("githubEventsWebhook without a secret", () => {
  test("cannot be written without a secret or an explicit opt-in", () => {
    // The first guarantee is the type: `WebhookVerification` has no shape that carries
    // neither, so this line does not compile.
    // @ts-expect-error - neither `credential` nor `allowUnverified`
    const missing: Parameters<typeof githubEventsWebhook>[0] = { onEvent: () => {} }

    // The second is the throw, for the caller the type cannot reach — plain JS, or one who
    // widened to `any`. `if (!options.secret) return` inside `.verify()` used to accept
    // anything that reached the route, and for a while it only warned, which a startup log
    // buries. Now `createSixb()` fails and the API role never starts.
    expect(() => githubEventsWebhook(missing)).toThrow(/X-Hub-Signature-256/)
  })

  test("warns only when unverified deliveries are accepted", () => {
    const unverified = captureWarnings(() =>
      githubEventsWebhook({ allowUnverified: true, onEvent: () => {} })
    )
    const verified = captureWarnings(() =>
      githubEventsWebhook({ credential: "whsec_test", onEvent: () => {} })
    )

    expect(unverified).toHaveLength(1)
    expect(unverified[0]).toContain("X-Hub-Signature-256")
    expect(unverified[0]).toContain("accepts unverified requests")
    expect(verified).toEqual([])
  })
})

/** Captures `console.warn` for the duration of one call. */
function captureWarnings(run: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return warnings
}
