import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { GitHubOrganizationInvitation, GitHubUsersApi } from "../src"
import { github } from "../src"

type IsOptional<T, K extends keyof T> = object extends Pick<T, K> ? true : false

const CONTEXT = {
  projectId: "demo",
  connectorId: "github",
  signal: new AbortController().signal,
}

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

describe("github people APIs", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("response contracts keep conditionally returned fields optional", () => {
    type AuthenticatedProfile = Awaited<ReturnType<GitHubUsersApi["getAuthenticated"]>>

    // Type-check guard: making either field required turns its assertion into a compile error.
    const privateGistsOptional = true satisfies IsOptional<AuthenticatedProfile, "private_gists">
    const invitationSourceOptional = true satisfies IsOptional<
      GitHubOrganizationInvitation,
      "invitation_source"
    >

    expect(privateGistsOptional).toBe(true)
    expect(invitationSourceOptional).toBe(true)
  })

  test("org().members.list maps member filters and pagination", async () => {
    let requested = ""
    mockFetch((input) => {
      requested = String(input)
      return Promise.resolve(json([{ login: "octocat", id: 1 }]))
    })

    const client = await github({ token: "t" }).connect(CONTEXT)
    const page = await client.org("acme").members.list({
      filter: "2fa_disabled",
      role: "admin",
      pageSize: 100,
    })

    const url = new URL(requested)
    expect(url.pathname).toBe("/orgs/acme/members")
    expect(url.searchParams.get("filter")).toBe("2fa_disabled")
    expect(url.searchParams.get("role")).toBe("admin")
    expect(url.searchParams.get("per_page")).toBe("100")
    expect(page.items[0]?.login).toBe("octocat")
  })

  test("org member checks map GitHub's 204 and 404 responses to booleans", async () => {
    mockFetch((input) => {
      const pathname = new URL(String(input)).pathname
      return Promise.resolve(
        new Response(null, { status: pathname.endsWith("/octocat") ? 204 : 404 })
      )
    })

    const members = (await github({ token: "t" }).connect(CONTEXT)).org("acme").members

    expect(await members.check("octocat")).toBe(true)
    expect(await members.check("hubot")).toBe(false)
  })

  test("org member APIs query public members and detailed membership", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      const url = String(input)
      calls.push(url)
      return Promise.resolve(
        url.includes("/memberships/")
          ? json({ state: "active", role: "member", user: { login: "octocat" } })
          : json([{ login: "octocat", id: 1 }])
      )
    })

    const members = (await github({ token: "t" }).connect(CONTEXT)).org("acme").members
    await members.listPublic({ pageSize: 50 })
    const membership = await members.getMembership("octocat")

    expect(new URL(calls[0] ?? "").pathname).toBe("/orgs/acme/public_members")
    expect(new URL(calls[0] ?? "").searchParams.get("per_page")).toBe("50")
    expect(new URL(calls[1] ?? "").pathname).toBe("/orgs/acme/memberships/octocat")
    expect(membership.state).toBe("active")
  })

  test("org people APIs query outside collaborators and pending invitations", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(json([]))
    })

    const org = (await github({ token: "t" }).connect(CONTEXT)).org("acme")
    await org.outsideCollaborators.list({ filter: "2fa_insecure", pageSize: 25 })
    await org.invitations.list({
      role: "direct_member",
      invitationSource: "scim",
      pageSize: 10,
    })

    const outside = new URL(calls[0] ?? "")
    expect(outside.pathname).toBe("/orgs/acme/outside_collaborators")
    expect(outside.searchParams.get("filter")).toBe("2fa_insecure")
    expect(outside.searchParams.get("per_page")).toBe("25")

    const invitations = new URL(calls[1] ?? "")
    expect(invitations.pathname).toBe("/orgs/acme/invitations")
    expect(invitations.searchParams.get("role")).toBe("direct_member")
    expect(invitations.searchParams.get("invitation_source")).toBe("scim")
    expect(invitations.searchParams.get("per_page")).toBe("10")
  })

  test("users API gets profiles by authentication, login, and durable ID", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(json({ login: "octocat", id: 1 }))
    })

    const users = (await github({ token: "t" }).connect(CONTEXT)).users
    await users.getAuthenticated()
    await users.get("octo/cat")
    await users.getById(42)
    await users.list({ since: 10, pageSize: 20 })

    expect(new URL(calls[0] ?? "").pathname).toBe("/user")
    expect(new URL(calls[1] ?? "").pathname).toBe("/users/octo%2Fcat")
    expect(new URL(calls[2] ?? "").pathname).toBe("/user/42")
    expect(new URL(calls[3] ?? "").pathname).toBe("/users")
    expect(new URL(calls[3] ?? "").searchParams.get("since")).toBe("10")
    expect(new URL(calls[3] ?? "").searchParams.get("per_page")).toBe("20")
  })

  test("authenticated-user memberships can be listed and fetched", async () => {
    const calls: string[] = []
    mockFetch((input) => {
      calls.push(String(input))
      return Promise.resolve(calls.length === 1 ? json([]) : json({ state: "pending" }))
    })

    const memberships = (await github({ token: "t" }).connect(CONTEXT)).memberships
    await memberships.list({ state: "pending", pageSize: 30 })
    const membership = await memberships.get("acme")

    const list = new URL(calls[0] ?? "")
    expect(list.pathname).toBe("/user/memberships/orgs")
    expect(list.searchParams.get("state")).toBe("pending")
    expect(list.searchParams.get("per_page")).toBe("30")
    expect(new URL(calls[1] ?? "").pathname).toBe("/user/memberships/orgs/acme")
    expect(membership.state).toBe("pending")
  })
})
