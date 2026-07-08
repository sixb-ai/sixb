import { afterEach, describe, expect, test } from "bun:test"
import { createTokenSource } from "../src/auth"
import { GoogleAuthError } from "../src/errors"
import {
  decodeJwtClaims,
  generateServiceAccountKey,
  json,
  mockFetch,
  restoreFetch,
  verifyJwt,
} from "./helpers"

afterEach(restoreFetch)

describe("createTokenSource — resolver mode", () => {
  test("delegates to the caller's token function", async () => {
    const source = createTokenSource({ token: () => "caller-token" })
    expect(await source.get()).toBe("caller-token")
    // invalidate is a no-op for resolver mode
    source.invalidate()
    expect(await source.get()).toBe("caller-token")
  })
})

describe("createTokenSource — service-account mode", () => {
  test("validates the key and scopes early", () => {
    expect(() => createTokenSource({ serviceAccountKey: "not json", scopes: ["s"] })).toThrow(
      GoogleAuthError
    )
    expect(() =>
      createTokenSource({
        serviceAccountKey: { client_email: "", private_key: "" },
        scopes: ["s"],
      })
    ).toThrow(/client_email/)
    expect(() =>
      createTokenSource({
        serviceAccountKey: { client_email: "a@b.c", private_key: "pk" },
        scopes: [],
      })
    ).toThrow(/scope/)
  })

  test("caches within the expiry margin and refreshes past it", async () => {
    let clock = 1_000_000
    let exchanges = 0
    const source = createTokenSource(
      { serviceAccountKey: { client_email: "a@b.c", private_key: "pk" }, scopes: ["s"] },
      {
        now: () => clock,
        exchange: async () => {
          exchanges++
          return { accessToken: `token-${exchanges}`, expiresInSec: 3600 }
        },
      }
    )

    expect(await source.get()).toBe("token-1")
    // Still well within the token's life → cached.
    clock += 60_000
    expect(await source.get()).toBe("token-1")
    expect(exchanges).toBe(1)

    // Advance to inside the 60s expiry margin → refresh.
    clock += 3600_000
    expect(await source.get()).toBe("token-2")
    expect(exchanges).toBe(2)
  })

  test("single-flights concurrent refreshes into one exchange", async () => {
    let exchanges = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const source = createTokenSource(
      { serviceAccountKey: { client_email: "a@b.c", private_key: "pk" }, scopes: ["s"] },
      {
        now: () => 0,
        exchange: async () => {
          exchanges++
          await gate
          return { accessToken: "token", expiresInSec: 3600 }
        },
      }
    )

    const all = Promise.all([source.get(), source.get(), source.get(), source.get()])
    release()
    expect(await all).toEqual(["token", "token", "token", "token"])
    expect(exchanges).toBe(1)
  })

  test("invalidate forces the next get to re-exchange", async () => {
    let exchanges = 0
    const source = createTokenSource(
      { serviceAccountKey: { client_email: "a@b.c", private_key: "pk" }, scopes: ["s"] },
      {
        now: () => 0,
        exchange: async () => {
          exchanges++
          return { accessToken: `token-${exchanges}`, expiresInSec: 3600 }
        },
      }
    )

    expect(await source.get()).toBe("token-1")
    source.invalidate()
    expect(await source.get()).toBe("token-2")
    expect(exchanges).toBe(2)
  })

  test("a failed exchange clears the in-flight slot so the next get retries", async () => {
    let attempt = 0
    const source = createTokenSource(
      { serviceAccountKey: { client_email: "a@b.c", private_key: "pk" }, scopes: ["s"] },
      {
        now: () => 0,
        exchange: async () => {
          attempt++
          if (attempt === 1) {
            throw new GoogleAuthError("boom")
          }
          return { accessToken: "recovered", expiresInSec: 3600 }
        },
      }
    )

    await expect(source.get()).rejects.toThrow(GoogleAuthError)
    expect(await source.get()).toBe("recovered")
  })
})

describe("createTokenSource — JWT signing (real crypto)", () => {
  test("signs a verifiable JWT-bearer assertion and returns the access token", async () => {
    const { key, publicKey } = await generateServiceAccountKey()
    let capturedAssertion = ""

    mockFetch(async (_input, init) => {
      const body = new URLSearchParams(init?.body as string)
      capturedAssertion = body.get("assertion") ?? ""
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
      return json({ access_token: "ya29.real", expires_in: 3600, token_type: "Bearer" })
    })

    const source = createTokenSource(
      {
        serviceAccountKey: key,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        subject: "user@customer.com",
      },
      { now: () => 1_700_000_000_000 }
    )

    expect(await source.get()).toBe("ya29.real")
    expect(await verifyJwt(capturedAssertion, publicKey)).toBe(true)

    const claims = decodeJwtClaims(capturedAssertion)
    expect(claims.iss).toBe(key.client_email)
    expect(claims.scope).toBe("https://www.googleapis.com/auth/drive.readonly")
    expect(claims.aud).toBe("https://oauth2.test/token")
    expect(claims.sub).toBe("user@customer.com")
    expect(claims.iat).toBe(1_700_000_000)
    expect(claims.exp).toBe(1_700_000_000 + 3600)
  })

  test("maps invalid_grant to a GoogleAuthError without retrying", async () => {
    const { key } = await generateServiceAccountKey()
    let calls = 0
    mockFetch(async () => {
      calls++
      return json(
        { error: "invalid_grant", error_description: "Invalid JWT Signature." },
        { status: 400 }
      )
    })

    const source = createTokenSource({ serviceAccountKey: key, scopes: ["s"] }, { now: () => 0 })
    await expect(source.get()).rejects.toThrow(/invalid_grant/)
    expect(calls).toBe(1)
  })
})
