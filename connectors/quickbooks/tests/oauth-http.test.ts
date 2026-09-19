import { afterEach, expect, test } from "bun:test"
import { ConnectorOAuthError, type ConnectorTokenSource } from "@sixb/core"
import { QuickBooksApiError, quickbooks } from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const options = {
  clientId: "client",
  clientSecret: "secret",
  environment: "sandbox",
  retry: { maxRetries: 0 },
} as const
const context = {
  projectId: "test",
  connectorId: "qb",
  signal: new AbortController().signal,
  redirectUri: "https://example.test/callback",
}
const credentials = {
  accessToken: "access",
  refreshToken: "refresh",
  authorizationContext: { realmId: "123" },
}
const tokenResponse = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  token_type: "bearer",
  expires_in: 3600,
}
const company = {
  Id: "1",
  CompanyName: "Example",
  LegalName: "Example LLC",
  NameValue: [{ Name: "IndustryType", Value: "Other" }],
}
function json(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers })
}
function mock(fn: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url, init) => Promise.resolve(fn(String(url), init ?? {}))) as typeof fetch
}
async function client(
  tokens?: ConnectorTokenSource,
  environment: "sandbox" | "production" = "sandbox",
  signal = context.signal
) {
  return quickbooks({ ...options, environment }).connect({
    ...context,
    signal,
    connectionId: "connection",
    account: { id: "123", label: "Example" },
    tokenSource: tokens ?? {
      async get() {
        return { accessToken: "access", invalidate() {} }
      },
    },
  })
}

test("OAuth consent and code exchange use Intuit endpoints, Basic auth and realm context", async () => {
  const adapter = quickbooks(options)
  expect(adapter.authentication.pkce).toBe("disabled")
  expect(adapter.authentication.callbackParameters).toEqual(["realmId"])
  const url = new URL(await adapter.authentication.authorizationUrl(context, { state: "state" }))
  expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2")
  expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting")
  expect(url.searchParams.get("state")).toBe("state")
  expect(url.searchParams.has("code_challenge")).toBe(false)
  mock((url, init) => {
    expect(url).toBe("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer")
    expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${btoa("client:secret")}`)
    expect(new URLSearchParams(String(init.body)).get("redirect_uri")).toBe(context.redirectUri)
    return json(tokenResponse)
  })
  const result = await adapter.authentication.exchangeCode(context, {
    code: "code",
    callbackParameters: { realmId: "123" },
  })
  expect(result.authorizationContext).toEqual({ realmId: "123" })
  expect(result.refreshToken).toBe("new-refresh")
  expect(result.expiresAt?.getTime()).toBeGreaterThan(Date.now())
})

test("refresh rotates both tokens and retains realm context; revoke uses the refresh token", async () => {
  const auth = quickbooks(options).authentication
  mock((_url, init) => {
    expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("refresh")
    return json(tokenResponse)
  })
  const result = await auth.refresh(context, credentials)
  expect(result.accessToken).toBe("new-access")
  expect(result.refreshToken).toBe("new-refresh")
  expect(result.authorizationContext).toEqual(credentials.authorizationContext)
  mock((url, init) => {
    expect(url).toBe("https://developer.api.intuit.com/v2/oauth2/tokens/revoke")
    expect(JSON.parse(String(init.body))).toEqual({ token: "new-refresh" })
    return new Response(null, { status: 200 })
  })
  await auth.revoke?.(context, result)
  mock(() => json({ error: "invalid_token" }, 400))
  await auth.revoke?.(context, result)
})

test("OAuth failures are classified without echoing secrets or replaying token exchanges", async () => {
  for (const [status, kind] of [
    [400, "terminal"],
    [401, "terminal"],
    [429, "retryable"],
    [503, "ambiguous"],
  ] as const) {
    let calls = 0
    mock(() => {
      calls++
      return json({ error_description: "secret access refresh" }, status)
    })
    try {
      await quickbooks(options).authentication.refresh(context, credentials)
      throw new Error("expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorOAuthError)
      expect(error).toHaveProperty("kind", kind)
      expect(String(error)).not.toContain("secret")
    }
    expect(calls).toBe(1)
  }
  mock(() => json({ ...tokenResponse, refresh_token: "" }))
  await expect(quickbooks(options).authentication.refresh(context, credentials)).rejects.toThrow(
    "Invalid OAuth token response"
  )
  mock(() => {
    throw new Error("secret network failure")
  })
  await expect(quickbooks(options).authentication.refresh(context, credentials)).rejects.toThrow(
    "outcome is unknown"
  )
})

test("discovery uses the authenticated realm rather than the CompanyInfo entity ID", async () => {
  // Live sandbox returns CompanyInfo.Id = "1". Restore company.Id !== id in readCompany
  // to reproduce the regression: successful discovery and company reads then reject.
  mock((url, init) => {
    expect(url).toBe(
      "https://sandbox-quickbooks.api.intuit.com/v3/company/123/companyinfo/123?minorversion=75"
    )
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access")
    return json({ CompanyInfo: company })
  })
  expect(await quickbooks(options).discoverAccounts(context, credentials)).toEqual([
    { id: "123", label: "Example", description: "Example LLC" },
  ])
  expect(await (await client()).companyInfo.get()).toEqual(company)
  mock(() => json({ CompanyInfo: { ...company, Id: "" } }))
  await expect(quickbooks(options).discoverAccounts(context, credentials)).rejects.toThrow(
    "requested company"
  )
  await expect(
    quickbooks(options).discoverAccounts(context, {
      ...credentials,
      authorizationContext: { realmId: "../456" },
    })
  ).rejects.toThrow("numeric company ID")
})

test("401 invalidates the exact rejected token and resolves a fresh token for replay", async () => {
  // Removal proof: remove onUnauthorized from createQuickBooksHttp; this test must fail.
  let gets = 0
  const invalidated: number[] = []
  const qb = await client({
    async get() {
      const revision = ++gets
      return {
        accessToken: `token-${revision}`,
        invalidate() {
          invalidated.push(revision)
        },
      }
    },
  })
  let calls = 0
  mock((_url, init) => {
    calls++
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer token-${calls}`)
    return calls === 1 ? json({}, 401) : json({ CompanyInfo: company })
  })
  expect(await qb.companyInfo.get()).toEqual(company)
  expect(invalidated).toEqual([1])
  expect(gets).toBe(2)
})

test("production host and structured Fault diagnostics", async () => {
  const qb = await client(undefined, "production")
  mock((url) => {
    expect(new URL(url).hostname).toBe("quickbooks.api.intuit.com")
    return json(
      {
        Fault: {
          type: "ValidationFault",
          Error: [{ code: "610", Message: "Object Not Found", Detail: "Deleted record" }],
        },
      },
      400,
      { intuit_tid: "trace-123" }
    )
  })
  try {
    await qb.companyInfo.get()
    throw new Error("expected rejection")
  } catch (error) {
    expect(error).toBeInstanceOf(QuickBooksApiError)
    expect(error).toHaveProperty("requestId", "trace-123")
    expect(error).toHaveProperty("errors.0.code", "610")
  }
})

test("read retries are bounded and reacquire tokens", async () => {
  let calls = 0
  let gets = 0
  const qb = await quickbooks({ ...options, retry: { maxRetries: 2, delayMs: () => 0 } }).connect({
    ...context,
    connectionId: "c",
    account: { id: "123", label: "test" },
    tokenSource: {
      async get() {
        gets++
        return { accessToken: "access", invalidate() {} }
      },
    },
  })
  mock(() => {
    calls++
    return json({}, 503)
  })
  await expect(qb.companyInfo.get()).rejects.toBeInstanceOf(QuickBooksApiError)
  expect(calls).toBe(3)
  expect(gets).toBe(3)
})

test("cancellation stops accounting and OAuth requests before fetch", async () => {
  const controller = new AbortController()
  const qb = await client(undefined, "sandbox", controller.signal)
  controller.abort(new Error("stop"))
  let calls = 0
  mock(() => {
    calls++
    return json({})
  })
  await expect(qb.companyInfo.get()).rejects.toThrow("stop")
  await expect(
    quickbooks(options).authentication.refresh(
      { ...context, signal: controller.signal },
      credentials
    )
  ).rejects.toThrow("stop")
  expect(calls).toBe(0)
})

test("invalid options and missing callback context fail before provider calls", async () => {
  expect(() => quickbooks({ ...options, minorVersion: 74 })).toThrow("minorVersion")
  expect(() => quickbooks({ ...options, timeoutMs: 0 })).toThrow("timeoutMs")
  expect(() => quickbooks({ ...options, minDelayMs: -1 })).toThrow("minDelayMs")
  expect(() => quickbooks({ ...options, clientSecret: "" })).toThrow("clientSecret")
  let calls = 0
  mock(() => {
    calls++
    return json({})
  })
  await expect(
    quickbooks(options).authentication.exchangeCode(context, { code: "code" })
  ).rejects.toThrow("realmId")
  expect(calls).toBe(0)
})

test("discovery does not replay rejected fixed credentials and malformed bodies fail clearly", async () => {
  let calls = 0
  mock(() => {
    calls++
    return json({}, 401)
  })
  await expect(quickbooks(options).discoverAccounts(context, credentials)).rejects.toBeInstanceOf(
    QuickBooksApiError
  )
  expect(calls).toBe(1)
  mock(() => new Response("not JSON", { status: 200 }))
  await expect((await client()).companyInfo.get()).rejects.toBeInstanceOf(QuickBooksApiError)
})

test("concurrent requests invalidate their own token handles", async () => {
  // Removal proof: replace requestTokens/handles lookup with one shared latest token;
  // release the first request's 401 after the second acquired its token. Invalidations must differ.
  let gets = 0
  const invalidated: number[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const qb = await client({
    async get() {
      const id = ++gets
      return {
        accessToken: `t${id}`,
        invalidate() {
          invalidated.push(id)
        },
      }
    },
  })
  mock(async (_url, init) => {
    const token = new Headers(init.headers).get("authorization")
    if (token === "Bearer t1") {
      await gate
      return json({}, 401)
    }
    if (token === "Bearer t2") {
      release?.()
      return json({ CompanyInfo: company })
    }
    return json({ CompanyInfo: company })
  })
  await Promise.all([qb.companyInfo.get(), qb.companyInfo.get()])
  expect(invalidated).toEqual([1])
  expect(gets).toBe(3)
})

test("OAuth timeout is ambiguous and is not replayed", async () => {
  let calls = 0
  mock((_url, init) => {
    calls++
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })
  })
  await expect(
    quickbooks({ ...options, timeoutMs: 5 }).authentication.refresh(context, credentials)
  ).rejects.toThrow("outcome is unknown")
  expect(calls).toBe(1)
})
