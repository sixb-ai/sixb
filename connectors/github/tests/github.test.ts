import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { noopLogger } from "@sixb/core"
import type { GitHubEventContext, GitHubEventHandler, GitHubIssueEvent } from "../src"
import { github, githubEventsWebhook } from "../src"

const CONTEXT = {
  projectId: "demo",
  connectorId: "github",
  signal: new AbortController().signal,
}

type VerifyCtx = Parameters<NonNullable<ReturnType<typeof githubEventsWebhook>["verify"]>>[0]
type HandleCtx = Parameters<ReturnType<typeof githubEventsWebhook>["handle"]>[0]

function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as unknown as typeof fetch
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

function pageToken(path: string): string {
  return Buffer.from(path).toString("base64url")
}

describe("github connector", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("connects with github auth headers", async () => {
    let auth = ""
    let version = ""
    mockFetch((_, init) => {
      const headers = new Headers(init?.headers)
      auth = headers.get("authorization") ?? ""
      version = headers.get("x-github-api-version") ?? ""
      return Promise.resolve(json([]))
    })

    const adapter = github({ token: "pat-123" })
    const client = await adapter.connect(CONTEXT)
    await client.repos.listForAuthenticatedUser()

    expect(adapter.type).toBe("github")
    expect(auth).toBe("Bearer pat-123")
    expect(version).toBe("2022-11-28")
  })

  test("repos.listForAuthenticatedUser fetches a page envelope with paging params", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(
        json([{ id: 1, name: "one" }], {
          headers: {
            link: '<https://api.github.com/user/repos?per_page=50&page=2>; rel="next"',
          },
        })
      )
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const page = await client.repos.listForAuthenticatedUser({ pageSize: 50 })

    const url = new URL(calls[0] ?? "")
    expect(url.searchParams.get("per_page")).toBe("50")
    expect(page.items.map((repo) => repo.id)).toEqual([1])
    expect(page.hasMore).toBe(true)
    expect(page.nextPageToken).toBeTruthy()
  })

  test("list calls send no paging params unless asked", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json([]))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await client.repos.listForAuthenticatedUser()

    const url = new URL(requested)
    expect(url.searchParams.has("page")).toBe(false)
    expect(url.searchParams.has("per_page")).toBe(false)
  })

  test("repos.listForAuthenticatedUser follows a pageToken returned from the Link header", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(
        json([{ id: calls.length, name: `repo-${calls.length}` }], {
          headers:
            calls.length === 1
              ? {
                  link: '<https://api.github.com/user/repos?per_page=1&page=2>; rel="next"',
                }
              : undefined,
        })
      )
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const first = await client.repos.listForAuthenticatedUser({ pageSize: 1 })
    const second = await client.repos.listForAuthenticatedUser({
      pageToken: first.nextPageToken,
    })

    expect(new URL(calls[1] ?? "").searchParams.get("page")).toBe("2")
    expect(second.items.map((repo) => repo.id)).toEqual([2])
    expect(second.hasMore).toBe(false)
  })

  test("repos.listForAuthenticatedUser maps authenticated user repository filters", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json([]))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await client.repos.listForAuthenticatedUser({
      visibility: "private",
      affiliation: ["owner", "collaborator"],
      sort: "updated",
      direction: "desc",
      since: "2026-01-01T00:00:00Z",
      before: "2026-02-01T00:00:00Z",
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/user/repos")
    expect(url.searchParams.get("visibility")).toBe("private")
    expect(url.searchParams.get("affiliation")).toBe("owner,collaborator")
    expect(url.searchParams.get("sort")).toBe("updated")
    expect(url.searchParams.get("direction")).toBe("desc")
    expect(url.searchParams.get("since")).toBe("2026-01-01T00:00:00Z")
    expect(url.searchParams.get("before")).toBe("2026-02-01T00:00:00Z")
  })

  test("org().repos.list maps organization repository filters", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json([]))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await client.org("acme").repos.list({
      type: "sources",
      sort: "full_name",
      direction: "asc",
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/orgs/acme/repos")
    expect(url.searchParams.get("type")).toBe("sources")
    expect(url.searchParams.get("sort")).toBe("full_name")
    expect(url.searchParams.get("direction")).toBe("asc")
    expect(url.searchParams.has("visibility")).toBe(false)
    expect(url.searchParams.has("affiliation")).toBe(false)
  })

  test("repo().get fetches the scoped repository", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json({ id: 1, name: "web" }))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const repo = await client.repo({ owner: "acme", repo: "web" }).get()

    expect(new URL(requested).pathname).toBe("/repos/acme/web")
    expect(repo.name).toBe("web")
  })

  test("rejects caller-provided pageTokens that decode to absolute URLs", async () => {
    let called = false
    mockFetch(() => {
      called = true
      return Promise.resolve(json([]))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await expect(
      client.repos.listForAuthenticatedUser({
        pageToken: pageToken("https://evil.example/repos?page=2"),
      })
    ).rejects.toThrow("Invalid pageToken")

    expect(called).toBe(false)
  })

  test("rejects pagination Link URLs outside the configured API base", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(
        json([{ id: 1, name: "one" }], {
          headers: {
            link: '<https://evil.example/user/repos?page=2>; rel="next"',
          },
        })
      )
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await expect(client.repos.listForAuthenticatedUser()).rejects.toThrow(
      "Refusing pagination URL outside the configured API base"
    )

    expect(calls).toHaveLength(1)
    expect(new URL(calls[0] ?? "").origin).toBe("https://api.github.com")
  })

  test("keeps trusted pageToken paths within a configured API base path", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(
        json([{ id: calls.length, name: `repo-${calls.length}` }], {
          headers:
            calls.length === 1
              ? {
                  link: '<https://ghe.example.com/api/v3/user/repos?page=2>; rel="next"',
                }
              : undefined,
        })
      )
    })

    const client = await github({
      token: "t",
      baseUrl: "https://ghe.example.com/api/v3/",
    }).connect(CONTEXT)
    const first = await client.repos.listForAuthenticatedUser()
    await client.repos.listForAuthenticatedUser({ pageToken: first.nextPageToken })

    expect(new URL(calls[1] ?? "").pathname).toBe("/api/v3/user/repos")
  })

  test("issues.listForAuthenticatedUser maps authenticated user issue filters", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json([]))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await client.issues.listForAuthenticatedUser({
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
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/issues")
    expect(url.searchParams.get("filter")).toBe("created")
    expect(url.searchParams.get("state")).toBe("all")
    expect(url.searchParams.get("labels")).toBe("bug,ui")
    expect(url.searchParams.get("sort")).toBe("updated")
    expect(url.searchParams.get("direction")).toBe("asc")
    expect(url.searchParams.get("since")).toBe("2026-01-01T00:00:00Z")
    expect(url.searchParams.get("collab")).toBe("true")
    expect(url.searchParams.get("orgs")).toBe("false")
    expect(url.searchParams.get("owned")).toBe("true")
    expect(url.searchParams.get("pulls")).toBe("false")
  })

  test("org().issues.listForAuthenticatedUser maps organization issue filters", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json([]))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await client.org("acme").issues.listForAuthenticatedUser({
      filter: "mentioned",
      state: "open",
      labels: ["bug"],
      type: "Incident",
      sort: "comments",
      direction: "desc",
      since: "2026-01-01T00:00:00Z",
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/orgs/acme/issues")
    expect(url.searchParams.get("filter")).toBe("mentioned")
    expect(url.searchParams.get("state")).toBe("open")
    expect(url.searchParams.get("labels")).toBe("bug")
    expect(url.searchParams.get("type")).toBe("Incident")
    expect(url.searchParams.get("sort")).toBe("comments")
    expect(url.searchParams.get("direction")).toBe("desc")
    expect(url.searchParams.get("since")).toBe("2026-01-01T00:00:00Z")
  })

  test("repo().issues.list preserves pull requests returned by GitHub", async () => {
    mockFetch(() =>
      Promise.resolve(
        json([
          { id: 1, number: 1, title: "bug" },
          { id: 2, number: 2, title: "pr", pull_request: { url: "x" } },
        ])
      )
    )

    const client = await github({ token: "t" }).connect(CONTEXT)
    const page = await client.repo({ owner: "acme", repo: "web" }).issues.list()

    expect(page.items.map((issue) => issue.number)).toEqual([1, 2])
  })

  test("repo().issues.list maps documented repository issue filters", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json([]))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await client.repo({ owner: "acme", repo: "web" }).issues.list({
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
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/repos/acme/web/issues")
    expect(url.searchParams.get("milestone")).toBe("none")
    expect(url.searchParams.get("state")).toBe("all")
    expect(url.searchParams.get("assignee")).toBe("octocat")
    expect(url.searchParams.get("type")).toBe("Incident")
    expect(url.searchParams.get("creator")).toBe("mona")
    expect(url.searchParams.get("mentioned")).toBe("hubot")
    expect(url.searchParams.get("issue_field_values")).toBe("priority:Urgent,severity:High")
    expect(url.searchParams.get("labels")).toBe("bug,ui")
    expect(url.searchParams.get("sort")).toBe("comments")
    expect(url.searchParams.get("direction")).toBe("asc")
    expect(url.searchParams.get("since")).toBe("2026-01-01T00:00:00Z")
  })

  test("repo().issues.list follows next page tokens", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(
        json([{ id: calls.length, number: calls.length, title: `issue-${calls.length}` }], {
          headers:
            calls.length === 1
              ? {
                  link: '<https://api.github.com/repos/acme/web/issues?state=all&page=2>; rel="next"',
                }
              : undefined,
        })
      )
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const issues = client.repo({ owner: "acme", repo: "web" }).issues
    const first = await issues.list({ state: "all" })
    const second = await issues.list({ pageToken: first.nextPageToken })

    expect(calls).toHaveLength(2)
    expect(first.items.map((issue) => issue.number)).toEqual([1])
    expect(second.items.map((issue) => issue.number)).toEqual([2])
  })

  test("repo().issues.get fetches a single issue", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json({ id: 10, number: 7, title: "Bug" }))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const issue = await client.repo({ owner: "acme", repo: "web" }).issues.get(7)

    expect(new URL(requested).pathname).toBe("/repos/acme/web/issues/7")
    expect(issue.number).toBe(7)
  })

  test("repo().issues.create posts to the repo issues endpoint", async () => {
    let path = ""
    let payload: Record<string, unknown> = {}
    mockFetch((input, init) => {
      path = new URL(String(input)).pathname
      payload = JSON.parse(String(init?.body))
      return Promise.resolve(json({ id: 10, number: 7, title: "Bug" }, { status: 201 }))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const issue = await client.repo({ owner: "acme", repo: "web" }).issues.create({
      title: "Bug",
      labels: ["triage"],
      issueFieldValues: [{ fieldId: 42, value: ["High"] }],
      type: "Incident",
    })

    expect(path).toBe("/repos/acme/web/issues")
    expect(payload.title).toBe("Bug")
    expect(payload.labels).toEqual(["triage"])
    expect(payload.issue_field_values).toEqual([{ field_id: 42, value: ["High"] }])
    expect(payload.type).toBe("Incident")
    expect(issue.number).toBe(7)
  })

  test("repo().issues.update sends a PATCH with mapped fields", async () => {
    let method = ""
    let path = ""
    let payload: Record<string, unknown> = {}
    mockFetch((input, init) => {
      path = new URL(String(input)).pathname
      method = init?.method ?? ""
      payload = JSON.parse(String(init?.body))
      return Promise.resolve(json({ id: 1, number: 7, state: "open", title: "Renamed" }))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await client.repo({ owner: "acme", repo: "web" }).issues.update(7, {
      title: "Renamed",
      stateReason: "reopened",
    })

    expect(path).toBe("/repos/acme/web/issues/7")
    expect(method).toBe("PATCH")
    expect(payload.title).toBe("Renamed")
    expect(payload.state_reason).toBe("reopened")
  })

  test("repo().issues.comments.list fetches issue comments with paging params", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(
        json([{ id: 1, body: "first" }], {
          headers: {
            link: '<https://api.github.com/repos/acme/web/issues/7/comments?per_page=50&page=2>; rel="next"',
          },
        })
      )
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const page = await client.repo({ owner: "acme", repo: "web" }).issues.comments.list(7, {
      pageSize: 50,
      since: "2026-01-01T00:00:00Z",
    })

    const url = new URL(calls[0] ?? "")
    expect(url.pathname).toBe("/repos/acme/web/issues/7/comments")
    expect(url.searchParams.get("per_page")).toBe("50")
    expect(url.searchParams.get("since")).toBe("2026-01-01T00:00:00Z")
    expect(page.items.map((comment) => comment.id)).toEqual([1])
    expect(page.nextPageToken).toBeTruthy()
  })

  test("repo().issues.comments.list follows next page tokens", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(
        json([{ id: calls.length, body: `comment-${calls.length}` }], {
          headers:
            calls.length === 1
              ? {
                  link: '<https://api.github.com/repos/acme/web/issues/7/comments?page=2>; rel="next"',
                }
              : undefined,
        })
      )
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const comments = client.repo({ owner: "acme", repo: "web" }).issues.comments
    const first = await comments.list(7)
    const second = await comments.list(7, { pageToken: first.nextPageToken })

    expect(new URL(calls[1] ?? "").searchParams.get("page")).toBe("2")
    expect(second.items.map((comment) => comment.id)).toEqual([2])
  })

  test("repo().issues.comments.create posts to the issue comments endpoint", async () => {
    let path = ""
    let payload: Record<string, unknown> = {}
    mockFetch((input, init) => {
      path = new URL(String(input)).pathname
      payload = JSON.parse(String(init?.body))
      return Promise.resolve(json({ id: 10, body: "Me too" }, { status: 201 }))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const comment = await client
      .repo({ owner: "acme", repo: "web" })
      .issues.comments.create(7, { body: "Me too" })

    expect(path).toBe("/repos/acme/web/issues/7/comments")
    expect(payload.body).toBe("Me too")
    expect(comment.id).toBe(10)
  })

  test("repo().issues.comments.get fetches a single issue comment", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json({ id: 99, body: "Me too" }))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const comment = await client.repo({ owner: "acme", repo: "web" }).issues.comments.get(99)

    expect(new URL(requested).pathname).toBe("/repos/acme/web/issues/comments/99")
    expect(comment.id).toBe(99)
  })

  test("repo().issues.comments.update sends a PATCH with body", async () => {
    let method = ""
    let path = ""
    let payload: Record<string, unknown> = {}
    mockFetch((input, init) => {
      path = new URL(String(input)).pathname
      method = init?.method ?? ""
      payload = JSON.parse(String(init?.body))
      return Promise.resolve(json({ id: 99, body: "Updated" }))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await client.repo({ owner: "acme", repo: "web" }).issues.comments.update(99, {
      body: "Updated",
    })

    expect(path).toBe("/repos/acme/web/issues/comments/99")
    expect(method).toBe("PATCH")
    expect(payload.body).toBe("Updated")
  })

  test("repo().issues.comments.delete sends DELETE to the issue comment endpoint", async () => {
    let method = ""
    let path = ""
    mockFetch((input, init) => {
      path = new URL(String(input)).pathname
      method = init?.method ?? ""
      return Promise.resolve(new Response(null, { status: 204 }))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await client.repo({ owner: "acme", repo: "web" }).issues.comments.delete(99)

    expect(path).toBe("/repos/acme/web/issues/comments/99")
    expect(method).toBe("DELETE")
  })

  test("repo().issues.comments methods reject invalid ids before requesting", async () => {
    let called = false
    mockFetch(() => {
      called = true
      return Promise.resolve(json({}))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const comments = client.repo({ owner: "acme", repo: "web" }).issues.comments

    await expect(comments.list(0)).rejects.toThrow("issueNumber must be a positive integer")
    await expect(comments.get(0)).rejects.toThrow("commentId must be a positive integer")

    expect(called).toBe(false)
  })

  test("repo().issues methods reject invalid issue numbers before requesting", async () => {
    let called = false
    mockFetch(() => {
      called = true
      return Promise.resolve(json({}))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    await expect(client.repo({ owner: "acme", repo: "web" }).issues.get(0)).rejects.toThrow(
      "issueNumber must be a positive integer"
    )

    expect(called).toBe(false)
  })

  test("throws GitHubApiError on non-2xx responses", async () => {
    mockFetch(() => Promise.resolve(json({ message: "Not Found" }, { status: 404 })))
    const client = await github({ token: "t" }).connect(CONTEXT)
    await expect(
      client.repo({ owner: "acme", repo: "web" }).issues.create({ title: "x" })
    ).rejects.toThrow("404")
  })

  describe("events webhook", () => {
    const sign = (secret: string, body: string): string =>
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

    test("registers only when onEvent is set", () => {
      expect(github({ token: "t" }).webhooks).toBeUndefined()
      expect(github({ token: "t", onEvent: () => {} }).webhooks).toHaveLength(1)
    })

    test("types payloads by narrowed webhook event name", () => {
      const handler: GitHubEventHandler = ({ event }) => {
        if (event.name !== "issues") {
          return
        }

        const action: GitHubIssueEvent["action"] = event.action
        const issueNumber: number = event.payload.issue.number

        expect(typeof action).toBe("string")
        expect(typeof issueNumber).toBe("number")
      }

      expect(handler).toBeDefined()
    })

    test("verifies the signature and forwards event + runtime to onEvent", async () => {
      const received: GitHubEventContext[] = []
      const webhook = githubEventsWebhook({
        secret: "shh",
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
      expect(received[0]?.event.name).toBe("issues")
      expect(received[0]?.event.action).toBe("opened")
      expect(received[0]?.event.deliveryId).toBe("d-1")
      // The live runtime and client resolver are passed straight through.
      expect(received[0]?.sixb).toBe(sixb as never)
      expect(received[0]?.logger).toBe(noopLogger)
      expect(received[0]?.client).toBe(client)
    })

    test("dispatches non-issue events too", async () => {
      const names: string[] = []
      const webhook = githubEventsWebhook({
        onEvent: (context) => {
          names.push(context.event.name)
        },
      })

      await webhook.handle({
        request: new Request("https://x/hook", {
          method: "POST",
          headers: { "x-github-event": "push" },
        }),
        body: { ref: "refs/heads/main" },
      } as unknown as HandleCtx)

      expect(names).toEqual(["push"])
    })

    test("rejects an invalid signature", () => {
      const webhook = githubEventsWebhook({ secret: "shh", onEvent: () => {} })
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
  test("says out loud that it will accept unsigned requests", () => {
    // `if (!options.secret) return` inside `.verify()` is a fine default for local
    // development and an open door in production, and it said nothing either way.
    const warnings = captureWarnings(() => githubEventsWebhook({ onEvent: () => {} }))

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("X-Hub-Signature-256")
    expect(warnings[0]).toContain("accepts unsigned requests")
  })

  test("stays quiet when a secret is configured", () => {
    const warnings = captureWarnings(() =>
      githubEventsWebhook({ secret: "whsec_test", onEvent: () => {} })
    )

    expect(warnings).toEqual([])
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
