import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { githubApp } from "../src/sandbox"

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
