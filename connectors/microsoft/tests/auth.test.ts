import { afterEach, describe, expect, test } from "bun:test"
import { constants, generateKeyPairSync, verify } from "node:crypto"
import { MicrosoftAuthError, MicrosoftConfigurationError, microsoft } from "../src"
import {
  apiError,
  CLIENT_ID,
  connect,
  discovery,
  json,
  mockFetch,
  restoreFetch,
  TENANT,
  TOKEN_URL,
  tokenResponse,
} from "./helpers"

afterEach(restoreFetch)
const auth = { tenantId: TENANT, clientId: CLIENT_ID, clientSecret: "secret +&=value" }

describe("Microsoft application authentication", () => {
  test("constructs lazily; real MSAL exchanges URL-encoded credentials and caches concurrent requests", async () => {
    let exchanges = 0
    const requests = mockFetch((r) => {
      const metadata = discovery(r.url)
      if (metadata) return metadata
      if (r.url.startsWith(TOKEN_URL)) {
        exchanges++
        const body = new URLSearchParams(String(r.init.body))
        expect(body.get("client_id")).toBe(CLIENT_ID)
        expect(body.get("client_secret")).toBe(auth.clientSecret)
        expect(body.get("grant_type")).toBe("client_credentials")
        expect(body.get("scope")).toBe("https://graph.microsoft.com/.default")
        expect(r.init.redirect).toBe("error")
        expect(r.init.signal).toBeInstanceOf(AbortSignal)
        return tokenResponse()
      }
      expect(r.headers.get("authorization")).toBe("Bearer msal-token")
      return json({ id: "site" })
    })
    const client = await connect({ auth })
    expect(requests).toHaveLength(0)
    await Promise.all(Array.from({ length: 8 }, () => client.sites.get("site")))
    await client.sites.get("site")
    expect(exchanges).toBe(1)
  })

  // Countercheck: set skipCache to false in src/auth/index.ts; this must fail.
  test("401 forces MSAL to bypass cache once; 403 neither refreshes nor retries", async () => {
    let exchanges = 0
    let calls = 0
    mockFetch((r) => {
      const metadata = discovery(r.url)
      if (metadata) return metadata
      if (r.url.startsWith(TOKEN_URL)) return tokenResponse(`token-${++exchanges}`)
      calls++
      if (calls === 1) return apiError(401, "InvalidAuthenticationToken")
      expect(r.headers.get("authorization")).toBe("Bearer token-2")
      return calls === 2 ? json({ id: "site" }) : apiError(403)
    })
    const client = await connect({ auth })
    await client.sites.get("site")
    await expect(client.sites.get("blocked")).rejects.toMatchObject({ status: 403 })
    expect(exchanges).toBe(2)
    expect(calls).toBe(3)
  })

  test("real MSAL signs certificate assertions verifiable with the matching public key", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    let signed = false
    mockFetch((r) => {
      const metadata = discovery(r.url)
      if (metadata) return metadata
      if (r.url.startsWith(TOKEN_URL)) {
        const body = new URLSearchParams(String(r.init.body))
        expect(body.has("client_secret")).toBe(false)
        expect(body.get("client_assertion_type")).toBe(
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        )
        const assertion = body.get("client_assertion") ?? ""
        const [headerPart, claimsPart, signature] = assertion.split(".")
        const header = JSON.parse(Buffer.from(headerPart, "base64url").toString())
        const claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString())
        expect(header.alg).toBe("PS256")
        expect(header["x5t#S256"]).toBe(Buffer.from("a".repeat(64), "hex").toString("base64url"))
        expect(claims.iss).toBe(CLIENT_ID)
        expect(claims.sub).toBe(CLIENT_ID)
        expect(claims.aud).toBe(TOKEN_URL)
        expect(claims.exp).toBeGreaterThan(claims.nbf)
        expect(
          verify(
            "sha256",
            Buffer.from(`${headerPart}.${claimsPart}`),
            { key: keys.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
            Buffer.from(signature, "base64url")
          )
        ).toBe(true)
        signed = true
        return tokenResponse()
      }
      return json({ id: "site" })
    })
    const client = await connect({
      auth: {
        tenantId: TENANT,
        clientId: CLIENT_ID,
        clientCertificate: { privateKey, thumbprintSha256: "a".repeat(64) },
      },
    })
    await client.sites.get("site")
    expect(signed).toBe(true)
  })

  test("expired MSAL tokens trigger another exchange", async () => {
    let exchanges = 0
    mockFetch(
      (r) =>
        discovery(r.url) ??
        (r.url.startsWith(TOKEN_URL)
          ? tokenResponse(`token-${++exchanges}`, -1)
          : json({ id: "site" }))
    )
    const client = await connect({ auth })
    await client.sites.get("site")
    await client.sites.get("site")
    expect(exchanges).toBe(2)
  })

  test("resolver learns when to bypass its cache, and authentication errors redact descriptions", async () => {
    const refresh: boolean[] = []
    let calls = 0
    mockFetch(() => (++calls === 1 ? apiError(401) : json({ id: "site" })))
    const client = await connect({
      auth: {
        token: ({ forceRefresh }) => {
          refresh.push(forceRefresh)
          return "token"
        },
      },
    })
    await client.sites.get("site")
    expect(refresh).toEqual([false, true])

    mockFetch(
      (r) =>
        discovery(r.url) ??
        json(
          { error: "invalid_client", error_description: `DO NOT LEAK ${auth.clientSecret}` },
          400
        )
    )
    const broken = await connect({ auth })
    const error = await broken.sites.get("site").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MicrosoftAuthError)
    expect(String(error)).not.toContain(auth.clientSecret)
    expect(String(error)).not.toContain("DO NOT LEAK")
  })

  test("token exchange is aborted by its configured timeout", async () => {
    mockFetch((r) => {
      const metadata = discovery(r.url)
      if (metadata) return metadata
      return new Promise((_, reject) => {
        const signal = r.init.signal!
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    })
    const client = await connect({ auth, timeoutMs: 20 })
    await expect(client.sites.get("site")).rejects.toBeInstanceOf(MicrosoftAuthError)
  })

  test("caller cancellation stops waiting for shared auth without failing the other caller", async () => {
    const pending = Promise.withResolvers<string>()
    const client = await connect({ auth: { token: () => pending.promise } })
    mockFetch(() => json({ id: "site" }))
    const controller = new AbortController()
    const cancelled = client.sites.get("site", { signal: controller.signal })
    const other = client.sites.get("site")
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
    pending.resolve("token")
    expect((await other).id).toBe("site")
  })

  test("rejects invalid tenant, fingerprint, secret and resolver tokens", async () => {
    expect(() => microsoft({ auth: { ...auth, tenantId: "common" } })).toThrow(
      MicrosoftConfigurationError
    )
    expect(() => microsoft({ auth: { ...auth, tenantId: "../other" } })).toThrow(
      MicrosoftConfigurationError
    )
    expect(() => microsoft({ auth: { ...auth, clientSecret: "" } })).toThrow(
      MicrosoftConfigurationError
    )
    expect(() =>
      microsoft({
        auth: {
          tenantId: TENANT,
          clientId: CLIENT_ID,
          clientCertificate: { privateKey: "key", thumbprintSha256: "bad" },
        },
      })
    ).toThrow(MicrosoftConfigurationError)
    expect(() => microsoft({ auth, timeoutMs: 0 })).toThrow(MicrosoftConfigurationError)
    const client = await connect({ auth: { token: () => "\r\ninjected" } })
    await expect(client.sites.get("site")).rejects.toBeInstanceOf(MicrosoftAuthError)
  })
})
