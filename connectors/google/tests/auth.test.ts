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
    expect((await source.getRequestHeaders?.())?.get("authorization")).toBe("Bearer caller-token")
    // invalidate is a no-op for resolver mode
    source.invalidate()
    expect(await source.get()).toBe("caller-token")
  })
})

describe("createTokenSource — Application Default Credentials mode", () => {
  test("validates scopes before attempting credential discovery", () => {
    expect(() => createTokenSource({ applicationDefault: true, scopes: [] })).toThrow(
      /non-empty scope/
    )
    expect(() => createTokenSource({ applicationDefault: true, scopes: ["   "] })).toThrow(
      /non-empty scope/
    )
  })

  test("discovers credentials lazily and single-flights concurrent token requests", async () => {
    let loads = 0
    let headerRequests = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const credentials = { access_token: "adc-token", expiry_date: Date.now() + 3600_000 }
    const source = createTokenSource(
      { applicationDefault: true, scopes: ["scope-a", "scope-b"] },
      {
        loadApplicationDefaultClient: async (scopes) => {
          loads++
          expect(scopes).toEqual(["scope-a", "scope-b"])
          await gate
          return {
            credentials,
            async getRequestHeaders() {
              headerRequests++
              return new Headers({
                Authorization: `Bearer ${credentials.access_token}`,
                "x-goog-user-project": "quota-project",
              })
            },
          }
        },
      }
    )

    expect(loads).toBe(0)
    const tokens = Promise.all([source.get(), source.get(), source.get()])
    await Promise.resolve()
    expect(loads).toBe(1)
    release()

    expect(await tokens).toEqual(["adc-token", "adc-token", "adc-token"])
    expect(loads).toBe(1)
    expect(headerRequests).toBe(1)

    const headers = await source.getRequestHeaders?.()
    expect(headers?.get("authorization")).toBe("Bearer adc-token")
    expect(headers?.get("x-goog-user-project")).toBe("quota-project")
    expect(loads).toBe(1)
    expect(headerRequests).toBe(2)
  })

  test("invalidates only the access token and refreshes it on the next request", async () => {
    let refreshes = 0
    const credentials = {
      access_token: null as string | null,
      expiry_date: null as number | null,
      refresh_token: "preserve-me",
    }
    const source = createTokenSource(
      { applicationDefault: true, scopes: ["scope"] },
      {
        loadApplicationDefaultClient: async () => ({
          credentials,
          async getRequestHeaders() {
            if (!credentials.access_token) {
              refreshes++
              credentials.access_token = `adc-token-${refreshes}`
              credentials.expiry_date = Date.now() + 3600_000
            }
            return new Headers({ Authorization: `Bearer ${credentials.access_token}` })
          },
        }),
      }
    )

    expect(await source.get()).toBe("adc-token-1")
    expect(await source.get()).toBe("adc-token-1")
    expect(refreshes).toBe(1)

    source.invalidate()
    expect(await source.get()).toBe("adc-token-2")
    expect(refreshes).toBe(2)
    expect(credentials.refresh_token).toBe("preserve-me")
  })

  test("retries discovery after a failure and preserves the original cause", async () => {
    const discoveryError = new Error("ADC is not configured")
    let attempts = 0
    const source = createTokenSource(
      { applicationDefault: true, scopes: ["scope"] },
      {
        loadApplicationDefaultClient: () => {
          attempts++
          if (attempts === 1) {
            throw discoveryError
          }
          return Promise.resolve({
            credentials: {},
            getRequestHeaders: async () => new Headers({ Authorization: "Bearer recovered" }),
          })
        },
      }
    )

    try {
      await source.get()
      throw new Error("expected ADC discovery to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleAuthError)
      expect((error as GoogleAuthError).message).toContain(
        "could not load Application Default Credentials"
      )
      expect((error as GoogleAuthError).cause).toBe(discoveryError)
    }

    expect(await source.get()).toBe("recovered")
    expect(attempts).toBe(2)
  })

  test("wraps token refresh failures and allows the next request to retry", async () => {
    const refreshError = new Error("refresh unavailable")
    let refreshes = 0
    const source = createTokenSource(
      { applicationDefault: true, scopes: ["scope"] },
      {
        loadApplicationDefaultClient: async () => ({
          credentials: {},
          async getRequestHeaders() {
            refreshes++
            if (refreshes === 1) {
              throw refreshError
            }
            return new Headers({ Authorization: "Bearer refreshed" })
          },
        }),
      }
    )

    try {
      await source.get()
      throw new Error("expected ADC token refresh to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleAuthError)
      expect((error as GoogleAuthError).message).toContain("could not obtain ADC request headers")
      expect((error as GoogleAuthError).cause).toBe(refreshError)
    }

    expect(await source.get()).toBe("refreshed")
    expect(refreshes).toBe(2)
  })

  test("rejects missing bearer authorization headers", async () => {
    const source = createTokenSource(
      { applicationDefault: true, scopes: ["scope"] },
      {
        loadApplicationDefaultClient: async () => ({
          credentials: {},
          getRequestHeaders: async () => new Headers(),
        }),
      }
    )

    await expect(source.get()).rejects.toThrow(/bearer Authorization header/)
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
