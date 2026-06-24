import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import type { GitHubEventContext } from "../src"
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

    const adapter = github({ token: "pat-123", owner: "acme", repo: "web" })
    const client = await adapter.connect(CONTEXT)
    await client.listRepositories()

    expect(adapter.type).toBe("github")
    expect(auth).toBe("Bearer pat-123")
    expect(version).toBe("2022-11-28")
  })

  test("listRepositories fetches a page envelope with paging params", async () => {
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
    const page = await client.listRepositories({ pageSize: 50 })

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
    await client.listRepositories()

    const url = new URL(requested)
    expect(url.searchParams.has("page")).toBe(false)
    expect(url.searchParams.has("per_page")).toBe(false)
  })

  test("listRepositories follows a pageToken returned from the Link header", async () => {
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
    const first = await client.listRepositories({ pageSize: 1 })
    const second = await client.listRepositories({ pageToken: first.nextPageToken })

    expect(new URL(calls[1] ?? "").searchParams.get("page")).toBe("2")
    expect(second.items.map((repo) => repo.id)).toEqual([2])
    expect(second.hasMore).toBe(false)
  })

  test("listIssues drops pull requests", async () => {
    mockFetch(() =>
      Promise.resolve(
        json([
          { id: 1, number: 1, title: "bug" },
          { id: 2, number: 2, title: "pr", pull_request: { url: "x" } },
        ])
      )
    )

    const client = await github({ token: "t", owner: "acme", repo: "web" }).connect(CONTEXT)
    const page = await client.listIssues()

    expect(page.items.map((issue) => issue.number)).toEqual([1])
  })

  test("iterIssues follows next page tokens", async () => {
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

    const client = await github({ token: "t", owner: "acme", repo: "web" }).connect(CONTEXT)
    const numbers: number[] = []
    for await (const issue of client.iterIssues({ state: "all" })) {
      numbers.push(issue.number)
    }

    expect(calls).toHaveLength(2)
    expect(numbers).toEqual([1, 2])
  })

  test("createIssue posts to the repo issues endpoint", async () => {
    let path = ""
    let payload: Record<string, unknown> = {}
    mockFetch((input, init) => {
      path = new URL(String(input)).pathname
      payload = JSON.parse(String(init?.body))
      return Promise.resolve(json({ id: 10, number: 7, title: "Bug" }, { status: 201 }))
    })

    const client = await github({ token: "t", owner: "acme", repo: "web" }).connect(CONTEXT)
    const issue = await client.createIssue({ title: "Bug", labels: ["triage"] })

    expect(path).toBe("/repos/acme/web/issues")
    expect(payload.title).toBe("Bug")
    expect(payload.labels).toEqual(["triage"])
    expect(issue.number).toBe(7)
  })

  test("updateIssue sends a PATCH with mapped fields", async () => {
    let method = ""
    let payload: Record<string, unknown> = {}
    mockFetch((_, init) => {
      method = init?.method ?? ""
      payload = JSON.parse(String(init?.body))
      return Promise.resolve(json({ id: 1, number: 7, state: "open", title: "Renamed" }))
    })

    const client = await github({ token: "t", owner: "acme", repo: "web" }).connect(CONTEXT)
    await client.updateIssue(7, { title: "Renamed", stateReason: "reopened" })

    expect(method).toBe("PATCH")
    expect(payload.title).toBe("Renamed")
    expect(payload.state_reason).toBe("reopened")
  })

  test("deleteIssue closes the issue via PATCH", async () => {
    let method = ""
    let payload: Record<string, unknown> = {}
    mockFetch((_, init) => {
      method = init?.method ?? ""
      payload = JSON.parse(String(init?.body))
      return Promise.resolve(json({ id: 1, number: 7, state: "closed" }))
    })

    const client = await github({ token: "t", owner: "acme", repo: "web" }).connect(CONTEXT)
    const issue = await client.deleteIssue(7)

    expect(method).toBe("PATCH")
    expect(payload.state).toBe("closed")
    expect(issue.state).toBe("closed")
  })

  test("requires owner and repo for issue operations", async () => {
    const client = await github({ token: "t" }).connect(CONTEXT)
    await expect(client.listIssues()).rejects.toThrow("owner and repo are required")
  })

  test("throws GitHubApiError on non-2xx responses", async () => {
    mockFetch(() => Promise.resolve(json({ message: "Not Found" }, { status: 404 })))
    const client = await github({ token: "t", owner: "acme", repo: "web" }).connect(CONTEXT)
    await expect(client.createIssue({ title: "x" })).rejects.toThrow("404")
  })

  describe("events webhook", () => {
    const sign = (secret: string, body: string): string =>
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

    test("registers only when onEvent is set", () => {
      expect(github({ token: "t" }).webhooks).toBeUndefined()
      expect(github({ token: "t", onEvent: () => {} }).webhooks).toHaveLength(1)
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
        client,
      } as unknown as HandleCtx)

      expect(received).toHaveLength(1)
      expect(received[0]?.event.name).toBe("issues")
      expect(received[0]?.event.action).toBe("opened")
      expect(received[0]?.event.deliveryId).toBe("d-1")
      // The live runtime and client resolver are passed straight through.
      expect(received[0]?.sixb).toBe(sixb as never)
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
