import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import type { ConnectorAccessToken, SandboxOAuthConnector } from "@sixb/core/sandboxes"
import { githubApp, githubOAuth } from "../src/sandbox"

// The key size is not under test; 1024 bits keeps key generation off the clock (2048 takes ~100ms).
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 })
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const IDENTITY = {
  GIT_AUTHOR_NAME: "sixb-agent[bot]",
  GIT_AUTHOR_EMAIL: "987+sixb-agent[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "sixb-agent[bot]",
  GIT_COMMITTER_EMAIL: "987+sixb-agent[bot]@users.noreply.github.com",
}

function fixture(
  options: {
    access?: "read" | "write"
    grant?: Record<string, unknown>
    tokenStatus?: number
    revokeStatus?: number
    app?: () => Response | Promise<Response>
    user?: () => Response
  } = {}
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const permissions =
    options.access === "write"
      ? { contents: "write", pull_requests: "write", metadata: "read" }
      : { contents: "read", metadata: "read" }
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith("/installation/token")) {
        return new Response(null, { status: options.revokeStatus ?? 204 })
      }
      if (url.endsWith("/installation")) return Response.json({ id: 42 })
      if (url.endsWith("/app")) {
        return options.app?.() ?? Response.json({ id: 123, slug: "sixb-agent" })
      }
      if (url.includes("/users/")) {
        // Echo the requested login: only the App checks can reject a bad slug.
        const login = decodeURIComponent(url.slice(url.indexOf("/users/") + "/users/".length))
        return options.user?.() ?? Response.json({ login, id: 987, type: "Bot" })
      }
      if (options.tokenStatus) {
        return Response.json(
          { message: "The permissions requested are not granted to this installation." },
          { status: options.tokenStatus }
        )
      }
      return Response.json({
        token: "test-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions,
        repositories: [{ full_name: "acme/website" }],
        ...options.grant,
      })
    },
    { preconnect() {} }
  ) as typeof fetch
  const auth = githubApp({ appId: "123", privateKey: pem })
  const authorize = (
    url = "https://github.com/acme/website.git",
    signal = new AbortController().signal
  ) =>
    auth.authorize({
      source: { type: "git", url, ...(options.access ? { access: options.access } : {}) },
      signal,
    })
  return { calls, auth, authorize }
}

describe("GitHub App workspace auth", () => {
  test("signs App JWTs, scopes the token, and exposes only exact Git read requests", async () => {
    // Regression proof: remove repositories from the token request; the body assertion fails.
    const f = fixture()
    const grant = await f.authorize()
    expect(f.calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/acme/website/installation",
      "https://api.github.com/app/installations/42/access_tokens",
      "https://api.github.com/app",
      "https://api.github.com/users/sixb-agent%5Bbot%5D",
    ])
    const bearer = new Headers(f.calls[0]?.init?.headers).get("Authorization")!
    const jwt = bearer.slice("Bearer ".length)
    const [header, payload, signature] = jwt.split(".")
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url")
      )
    ).toBe(true)
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: "123" })
    expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({
      repositories: ["website"],
      permissions: { contents: "read" },
    })
    expect(grant.requests.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: "/acme/website.git/info/refs", method: "GET" },
      { path: "/acme/website.git/git-upload-pack", method: "POST" },
    ])
    expect(grant.requests[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from("x-access-token:test-installation-token").toString("base64")}`
    )
    expect(JSON.stringify(f.auth)).not.toContain("PRIVATE")
    expect(f.calls.every((call) => call.init?.redirect === "error")).toBe(true)
    await grant.revoke()
    await grant.revoke()
    expect(f.calls).toHaveLength(5)
  })

  test("read access commits as the App's bot with no API access or placeholder", async () => {
    // Regression proof: return `{}` as the read env; the identity equality fails.
    const f = fixture()
    const grant = await f.authorize()

    expect(grant.env).toEqual(IDENTITY)
    expect(JSON.stringify(grant.env)).not.toContain("test-installation-token")
    expect(grant.requests.some((request) => request.origin === "https://api.github.com")).toBe(
      false
    )

    // The slug needs the App JWT; the bot user is read with the installation token.
    const authorization = (index: number) =>
      new Headers(f.calls[index]?.init?.headers).get("Authorization")
    expect(authorization(2)).toStartWith("Bearer ey")
    expect(authorization(3)).toBe("Bearer test-installation-token")
    await grant.revoke()
  })

  test("write pushes and reaches the whole GitHub API with a placeholder token", async () => {
    // Regression proof: request { contents: "write" } alone; the body assertion fails.
    const f = fixture({ access: "write" })
    const grant = await f.authorize()

    expect(JSON.parse(String(f.calls[1]?.init?.body)).permissions).toEqual({
      contents: "write",
      pull_requests: "write",
    })
    expect(grant.requests.slice(2)).toEqual([
      {
        origin: "https://github.com",
        path: "/acme/website.git/git-receive-pack",
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from("x-access-token:test-installation-token").toString("base64")}`,
        },
      },
      // Regression proof: go back to one exact API path; this target no longer matches.
      {
        origin: "https://api.github.com",
        path: { prefix: "/" },
        method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        headers: { Authorization: "Bearer test-installation-token" },
      },
    ])

    // GitHub clients read either variable. The host replaces the header, so the real token
    // never enters. Regression proof: drop GITHUB_TOKEN from the write env; this fails.
    const placeholder = "placeholder-replaced-outside-the-sandbox"
    expect(grant.env).toEqual({ ...IDENTITY, GH_TOKEN: placeholder, GITHUB_TOKEN: placeholder })
    expect(JSON.stringify(grant.env)).not.toContain("test-installation-token")
    await grant.revoke()
  })

  test.each([
    { access: "read" as const, label: "Contents: read" },
    { access: "write" as const, label: "Contents and Pull requests: write" },
  ])("explains missing $access permissions without the provider response", async ({
    access,
    label,
  }) => {
    // Regression proof: drop the 422 entry from the token request; the generic HTTP 422 remains.
    const f = fixture({ access, tokenStatus: 422 })
    const failure = await f.authorize().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain(
      `[SixbGitHub] The App installation does not grant the permissions this workspace needs (${label}). Update the App's permissions and approve them on the installation.`
    )
    expect(String(failure)).not.toContain("not granted to this installation")
  })

  test("looks the bot identity up once per App and retries a failed lookup", async () => {
    // Regression proof: drop the lookup reset on failure; the second authorize keeps failing.
    let apps = 0
    const f = fixture({
      app: () =>
        ++apps === 1
          ? new Response(null, { status: 503 })
          : Response.json({ id: 123, slug: "sixb-agent" }),
    })

    await expect(f.authorize()).rejects.toThrow("HTTP 503")
    expect(f.calls.at(-1)?.init?.method).toBe("DELETE")

    const first = await f.authorize()
    const second = await f.authorize()

    // Regression proof: look the identity up on every call; three lookups are counted.
    expect(apps).toBe(2)
    expect(f.calls.filter((call) => call.url.includes("/users/"))).toHaveLength(1)
    expect(second.env).toEqual(first.env)
    await first.revoke()
    await second.revoke()
  })

  test("shares one pending bot identity lookup between concurrent runs", async () => {
    // Regression proof: memoize the identity only once it resolves; both runs call /app.
    let release!: () => void
    const answered = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = fixture({
      app: async () => {
        await answered
        return Response.json({ id: 123, slug: "sixb-agent" })
      },
    })

    const runs = Promise.all([f.authorize(), f.authorize()])
    while (f.calls.filter((call) => call.url.endsWith("/access_tokens")).length < 2) {
      await Bun.sleep(1)
    }
    // Let the second run reach the lookup while the first one is still pending.
    await Bun.sleep(10)
    release()
    const [first, second] = await runs

    expect(f.calls.filter((call) => call.url.endsWith("/app"))).toHaveLength(1)
    expect(second.env).toEqual(first.env)
    await first.revoke()
    await second.revoke()
  })

  test.each([
    { id: 456, slug: "sixb-agent" },
    { id: 123, slug: "sixb agent\nGIT_DIR=/tmp" },
    { id: 123 },
  ])("rejects an invalid App and revokes the token before any bot lookup: %j", async (app) => {
    // Regression proof: remove the slug pattern check; the fixture echoes the requested login, so
    // the injected slug resolves as a bot.
    const f = fixture({ app: () => Response.json(app) })

    await expect(f.authorize()).rejects.toThrow("[SixbGitHub] App response is invalid.")
    expect(f.calls.some((call) => call.url.includes("/users/"))).toBe(false)
    expect(f.calls.at(-1)?.init?.method).toBe("DELETE")
  })

  test.each([
    { login: "someone-else[bot]", id: 987, type: "Bot" },
    { login: "sixb-agent[bot]", id: 987, type: "User" },
    { login: "sixb-agent[bot]", id: "987", type: "Bot" },
    { login: "sixb-agent[bot]", id: 0, type: "Bot" },
  ])("rejects an invalid bot user and revokes the token: %j", async (user) => {
    // Regression proof: remove the user.type check; the "User" case resolves.
    const f = fixture({ user: () => Response.json(user) })

    await expect(f.authorize()).rejects.toThrow("[SixbGitHub] App bot user response is invalid.")
    expect(f.calls.at(-1)?.init?.method).toBe("DELETE")
  })

  test("revokes and rejects a run aborted during the shared identity lookup", async () => {
    // Regression proof: drop the signal check after gitIdentity(); the aborted run resolves.
    const controller = new AbortController()
    const f = fixture({
      app: () => {
        controller.abort()
        return Response.json({ id: 123, slug: "sixb-agent" })
      },
    })

    await expect(f.authorize(undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(f.calls.at(-1)?.init?.method).toBe("DELETE")
  })

  test("keeps the original error when revoking after it also fails", async () => {
    // Regression proof: call revoke() instead of revokeAfterFailure(); the revocation's HTTP 503
    // replaces both original errors.
    const errors = spyOn(console, "error").mockImplementation(() => {})

    try {
      const mismatch = fixture({
        revokeStatus: 503,
        grant: { repositories: [{ full_name: "acme/other" }] },
      })
      await expect(mismatch.authorize()).rejects.toThrow("did not match")

      const identity = fixture({ revokeStatus: 503, app: () => Response.json({ id: 456 }) })
      await expect(identity.authorize()).rejects.toThrow("[SixbGitHub] App response is invalid.")

      expect(errors).toHaveBeenCalledTimes(2)
      expect(errors).toHaveBeenCalledWith(
        "[SixbGitHub] Installation token revocation failed after an authorization error."
      )
    } finally {
      errors.mockRestore()
    }
  })

  test.each([
    "http://github.com/acme/website.git",
    "https://evil.com/acme/website.git",
    "https://token@github.com/acme/website.git",
    "https://github.com/acme/website.git?token=x",
    "https://github.com/acme/website.git/extra",
    "https://github.com/acme/%77ebsite.git",
  ])("rejects unsupported or ambiguous repository URLs before any request: %s", async (url) => {
    const f = fixture()
    await expect(f.authorize(url)).rejects.toThrow("[SixbGitHub]")
    expect(f.calls).toHaveLength(0)
  })

  test.each([
    { grant: { repositories: [{ full_name: "acme/other" }] } },
    { grant: { permissions: { contents: "write" } } },
    { grant: { permissions: { contents: "read", issues: "write" } } },
    { grant: { expires_at: new Date(0).toISOString() } },
    { access: "write" as const, grant: { permissions: { contents: "write" } } },
    {
      access: "write" as const,
      grant: { permissions: { contents: "write", pull_requests: "read" } },
    },
  ])("revokes unexpected grants before returning access: %j", async (options) => {
    // Regression proof: accept any pull_requests level; the pull_requests read case resolves.
    const f = fixture(options)
    await expect(f.authorize()).rejects.toThrow("did not match")
    expect(f.calls.at(-1)?.init?.method).toBe("DELETE")
  })

  test("does not leak provider response or request details on failure", async () => {
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("Authorization: secret-token PRIVATE KEY")
      },
      { preconnect() {} }
    ) as typeof fetch
    const auth = githubApp({ appId: "123", privateKey: pem })
    await expect(
      auth.authorize({
        source: { type: "git", url: "https://github.com/acme/website.git" },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("[SixbGitHub] Workspace authentication request failed.")
  })

  test("accepts a private key whose newlines are escaped, as environment variables hold it", () => {
    // Regression proof: pass options.privateKey to createPrivateKey unchanged; this key throws.
    const escaped = pem.trim().replaceAll("\n", "\\n")

    expect(() => githubApp({ appId: "123", privateKey: escaped })).not.toThrow()
    expect(() => githubApp({ appId: "123", privateKey: "not a key" })).toThrow(
      "[SixbGitHub] App private key must be a valid RSA PEM key (escaped \\n newlines are accepted)."
    )
  })

  test("reports revocation failure and permits a retry", async () => {
    const f = fixture({ revokeStatus: 503 })
    const grant = await f.authorize()
    await expect(grant.revoke()).rejects.toThrow("HTTP 503")
    await expect(grant.revoke()).rejects.toThrow("HTTP 503")
    expect(f.calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(2)
  })
})

const OAUTH_CONNECTOR: SandboxOAuthConnector = {
  kind: "connector",
  id: "github",
  adapter: { authentication: { type: "oauth2" } },
}

const USER_IDENTITY = {
  GIT_AUTHOR_NAME: "Ada Lovelace",
  GIT_AUTHOR_EMAIL: "4242+adalovelace@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Ada Lovelace",
  GIT_COMMITTER_EMAIL: "4242+adalovelace@users.noreply.github.com",
}

function oauthFixture(
  options: {
    access?: "read" | "write"
    owner?: "user" | "project"
    slot?: string
    requestedBy?: { readonly type: "user" | "serviceAccount"; readonly id: string }
    parentTokens?: readonly string[]
    grant?: Record<string, unknown>
    scopedStatuses?: number[]
    revokeStatus?: number
    fallback?: ReturnType<typeof githubApp>
  } = {}
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const tokenLookups: unknown[] = []
  let invalidations = 0
  let tokenIndex = 0
  const parentTokens = options.parentTokens ?? ["ghu_parent_1", "ghu_parent_2"]
  const statuses = [...(options.scopedStatuses ?? [])]
  const permissions =
    options.access === "write"
      ? { contents: "write", pull_requests: "write", metadata: "read" }
      : { contents: "read", metadata: "read" }

  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith("/applications/Iv1.client123/token") && init?.method === "DELETE") {
        return new Response(null, { status: options.revokeStatus ?? 204 })
      }
      if (url.endsWith("/applications/Iv1.client123/token/scoped")) {
        const nextStatus = statuses.shift()
        if (nextStatus !== undefined) {
          return Response.json(
            { message: "provider detail must never leak" },
            { status: nextStatus }
          )
        }
        return Response.json({
          token: "ghu_scoped_token",
          expires_at: new Date(Date.now() + 28_800_000).toISOString(),
          app: { client_id: "Iv1.client123", name: "Sixb", url: "https://github.com/apps/sixb" },
          installation: {
            repository_selection: "selected",
            permissions,
            account: { login: "acme", id: 1, type: "Organization" },
          },
          user: {
            id: 4242,
            login: "adalovelace",
            name: "Ada Lovelace",
            type: "User",
          },
          ...options.grant,
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    },
    { preconnect() {} }
  ) as typeof fetch

  const auth = githubOAuth({
    connector: OAUTH_CONNECTOR,
    clientId: "Iv1.client123",
    clientSecret: "super-secret-value",
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    ...(options.slot === undefined ? {} : { slot: options.slot }),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
  })

  const connectionToken = async (
    connector: SandboxOAuthConnector,
    selector: unknown
  ): Promise<ConnectorAccessToken> => {
    tokenLookups.push({ connector, selector })
    const accessToken = parentTokens[Math.min(tokenIndex++, parentTokens.length - 1)]!
    return {
      accessToken,
      invalidate() {
        invalidations++
      },
    }
  }

  const hasRequestedBy = Object.hasOwn(options, "requestedBy")
  const authorize = (
    url = "https://github.com/acme/website.git",
    signal = new AbortController().signal
  ) =>
    auth.authorize({
      source: { type: "git", url, ...(options.access ? { access: options.access } : {}) },
      signal,
      ...(hasRequestedBy
        ? options.requestedBy === undefined
          ? {}
          : { requestedBy: options.requestedBy }
        : { requestedBy: { type: "user", id: "usr_ada" } }),
      connectionToken,
    })

  return {
    calls,
    auth,
    authorize,
    tokenLookups,
    invalidations: () => invalidations,
  }
}

describe("GitHub OAuth workspace auth", () => {
  test("scopes the requester's OAuth token to one repository, attributes commits to them, and revokes only the scoped token", async () => {
    // Regression proof: omit repositories or permissions from /token/scoped, or use /grant on revoke.
    const f = oauthFixture({ access: "write" })
    const grant = await f.authorize()

    expect(f.tokenLookups).toEqual([
      {
        connector: OAUTH_CONNECTOR,
        selector: { owner: { type: "user", id: "usr_ada" }, slot: "default" },
      },
    ])
    expect(f.calls.map((call) => call.url)).toEqual([
      "https://api.github.com/applications/Iv1.client123/token/scoped",
    ])
    const authHeader = new Headers(f.calls[0]?.init?.headers).get("Authorization")
    expect(authHeader).toBe(
      `Basic ${Buffer.from("Iv1.client123:super-secret-value").toString("base64")}`
    )
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({
      access_token: "ghu_parent_1",
      target: "acme",
      repositories: ["website"],
      permissions: { contents: "write", pull_requests: "write" },
    })
    expect(grant.env).toEqual({
      ...USER_IDENTITY,
      GH_TOKEN: "placeholder-replaced-outside-the-sandbox",
      GITHUB_TOKEN: "placeholder-replaced-outside-the-sandbox",
    })
    expect(grant.requests.map(({ origin, path, method }) => ({ origin, path, method }))).toEqual([
      { origin: "https://github.com", path: "/acme/website.git/info/refs", method: "GET" },
      { origin: "https://github.com", path: "/acme/website.git/git-upload-pack", method: "POST" },
      { origin: "https://github.com", path: "/acme/website.git/git-receive-pack", method: "POST" },
      {
        origin: "https://api.github.com",
        path: { prefix: "/" },
        method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
    ])
    expect(JSON.stringify(f.auth)).not.toContain("super-secret-value")

    await grant.revoke()
    await grant.revoke()
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]?.url).toBe("https://api.github.com/applications/Iv1.client123/token")
    expect(f.calls[1]?.init?.method).toBe("DELETE")
    expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({
      access_token: "ghu_scoped_token",
    })
  })

  test("read access sets the user's Git identity without API access or token placeholders, and treats 404 revoke as idempotent", async () => {
    const f = oauthFixture({
      access: "read",
      revokeStatus: 404,
      grant: {
        user: { id: 4242, login: "adalovelace", name: "Ada\n<Lovelace>", type: "User" },
      },
    })
    const grant = await f.authorize()

    expect(grant.env).toEqual({
      ...USER_IDENTITY,
      GIT_AUTHOR_NAME: "AdaLovelace",
      GIT_COMMITTER_NAME: "AdaLovelace",
    })
    expect(grant.requests).toHaveLength(2)
    await expect(grant.revoke()).resolves.toBeUndefined()
  })

  test("invalidates a stale parent token on 404 from /token/scoped and retries once with the refreshed token", async () => {
    // Regression proof: drop the 404 catch in githubOAuth; the stale token fails without refreshing.
    const f = oauthFixture({
      scopedStatuses: [404],
      parentTokens: ["ghu_stale", "ghu_fresh"],
    })
    const grant = await f.authorize()

    expect(f.invalidations()).toBe(1)
    expect(f.tokenLookups).toHaveLength(2)
    expect(f.calls).toHaveLength(2)
    expect(JSON.parse(String(f.calls[1]?.init?.body)).access_token).toBe("ghu_fresh")
    await grant.revoke()
  })

  test("supports project-owned connections and custom slots, and delegates to fallback only when no user requested the run", async () => {
    // Regression proof: use fallback when a user's connection lookup fails; their commits silently become bot commits.
    const project = oauthFixture({ owner: "project", slot: "engineering", requestedBy: undefined })
    await (await project.authorize()).revoke()
    expect(project.tokenLookups[0]).toMatchObject({
      selector: { owner: { type: "project" }, slot: "engineering" },
    })

    let fallbackCalls = 0
    const fallback = {
      authorize: async () => {
        fallbackCalls++
        return {
          requests: [
            {
              origin: "https://github.com",
              path: "/acme/website.git/info/refs",
              method: "GET" as const,
              headers: { Authorization: "Basic ZmFsbGJhY2s=" },
            },
          ],
          expiresAt: new Date(Date.now() + 3_600_000),
          revoke: async () => {},
        }
      },
    }
    const background = oauthFixture({
      requestedBy: undefined,
      fallback: fallback as ReturnType<typeof githubApp>,
    })
    await background.authorize()
    expect(fallbackCalls).toBe(1)
    expect(background.tokenLookups).toHaveLength(0)

    const noFallback = oauthFixture({ requestedBy: { type: "serviceAccount", id: "svc_1" } })
    await expect(noFallback.authorize()).rejects.toThrow("requires a run requested by a user")
  })

  test.each([
    [401, "[SixbGitHub] GitHub rejected the OAuth client credentials."],
    [
      403,
      "[SixbGitHub] Either the GitHub App is not installed on this repository or the connected GitHub account cannot access it.",
    ],
    [
      422,
      "[SixbGitHub] The GitHub App or connected account does not grant the permissions this workspace needs (Contents and Pull requests: write).",
    ],
  ])("maps status %i to an actionable error without leaking provider details", async (status, message) => {
    const f = oauthFixture({ access: "write", scopedStatuses: [status] })
    const error = await f.authorize().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(message)
    expect((error as Error).message).not.toContain("provider detail")
  })

  test.each([
    { expires_at: null },
    { expires_at: "1970-01-01T00:00:00.000Z" },
    { app: { client_id: "Iv1.other" } },
    {
      installation: {
        repository_selection: "all",
        permissions: { contents: "read", metadata: "read" },
        account: { login: "acme" },
      },
    },
    {
      installation: {
        repository_selection: "selected",
        permissions: { contents: "write", metadata: "read" },
        account: { login: "acme" },
      },
    },
    {
      installation: {
        repository_selection: "selected",
        permissions: { contents: "read", metadata: "read" },
        account: { login: "other-org" },
      },
    },
    { user: { id: 4242, login: "sixb[bot]", type: "Bot" } },
    { user: { id: 0, login: "adalovelace", type: "User" } },
  ])("revokes unexpected scoped grants before rejecting: %j", async (grant) => {
    const f = oauthFixture({ grant })
    await expect(f.authorize()).rejects.toThrow("[SixbGitHub]")
    expect(f.calls.map((call) => call.init?.method)).toEqual(["POST", "DELETE"])
  })

  test("validates configuration before serving any request", () => {
    expect(() =>
      githubOAuth({
        connector: { kind: "connector", id: "gh", adapter: {} } as unknown as SandboxOAuthConnector,
        clientId: "Iv1.client",
        clientSecret: "secret",
      })
    ).toThrow("requires a GitHub OAuth connector")
    expect(() =>
      githubOAuth({ connector: OAUTH_CONNECTOR, clientId: "bad:id", clientSecret: "secret" })
    ).toThrow("OAuth client ID")
    expect(() =>
      githubOAuth({ connector: OAUTH_CONNECTOR, clientId: "Iv1.ok", clientSecret: "bad\nsecret" })
    ).toThrow("OAuth client secret")
  })
})
