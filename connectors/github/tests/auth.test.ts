import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { githubApp } from "../src/auth"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function fixture(
  options: {
    access?: "read" | "write"
    grant?: Record<string, unknown>
    revokeStatus?: number
  } = {}
) {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith("/installation/token")) {
        return new Response(null, { status: options.revokeStatus ?? 204 })
      }
      if (url.endsWith("/installation")) return Response.json({ id: 42 })
      return Response.json({
        token: "test-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { contents: options.access ?? "read", metadata: "read" },
        repositories: [{ full_name: "acme/website" }],
        ...options.grant,
      })
    },
    { preconnect() {} }
  ) as typeof fetch
  const auth = githubApp({ appId: "123", privateKey: pem })
  const authorize = (url = "https://github.com/acme/website.git") =>
    auth.authorize({
      source: { type: "git", url, ...(options.access ? { access: options.access } : {}) },
      signal: new AbortController().signal,
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
    expect(f.calls).toHaveLength(3)
  })

  test("write is explicit and adds only the receive-pack endpoint", async () => {
    const f = fixture({ access: "write" })
    const grant = await f.authorize()
    expect(JSON.parse(String(f.calls[1]?.init?.body)).permissions).toEqual({ contents: "write" })
    expect(grant.requests.at(-1)).toMatchObject({
      path: "/acme/website.git/git-receive-pack",
      method: "POST",
    })
    await grant.revoke()
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
    await expect(f.authorize(url)).rejects.toThrow("[GitHub]")
    expect(f.calls).toHaveLength(0)
  })

  test.each([
    { repositories: [{ full_name: "acme/other" }] },
    { permissions: { contents: "write" } },
    { permissions: { contents: "read", issues: "write" } },
    { expires_at: new Date(0).toISOString() },
  ])("revokes unexpected grants before returning access: %j", async (grant) => {
    const f = fixture({ grant })
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
    ).rejects.toThrow("[GitHub] Workspace authentication request failed.")
  })

  test("reports revocation failure and permits a retry", async () => {
    const f = fixture({ revokeStatus: 503 })
    const grant = await f.authorize()
    await expect(grant.revoke()).rejects.toThrow("HTTP 503")
    await expect(grant.revoke()).rejects.toThrow("HTTP 503")
    expect(f.calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(2)
  })
})
