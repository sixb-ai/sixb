import { afterEach, describe, expect, test } from "bun:test"
import {
  type ConnectorAccessToken,
  type ConnectorConnectionClientContext,
  ConnectorOAuthError,
  type ConnectorOAuthErrorKind,
  defineConnector,
} from "@sixb/core"
import { MicrosoftConfigurationError, type MicrosoftOAuthOptions, microsoft } from "../src"
import { CLIENT_ID, CONTEXT, GRAPH, json, mockFetch, restoreFetch, TENANT } from "./helpers"

afterEach(restoreFetch)

const OAUTH = {
  tenantId: TENANT,
  clientId: CLIENT_ID,
  clientSecret: "secret +&=value",
  scopes: ["Mail.Read", "Calendars.Read"],
} as const satisfies MicrosoftOAuthOptions
const ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`
const AUTHORIZATION_CONTEXT = {
  ...CONTEXT,
  redirectUri: "https://api.sixb.test/auth/connectors/callback",
}
const connector = (oauth: Partial<MicrosoftOAuthOptions> = {}) =>
  microsoft({ auth: { oauth: { ...OAUTH, ...oauth } } })

function tokenEndpoint(respond: (form: URLSearchParams) => Response) {
  const forms: URLSearchParams[] = []
  mockFetch((request) => {
    expect(request.url).toBe(`${ENDPOINT}/token`)
    expect(request.init.redirect).toBe("error")
    const form = new URLSearchParams(String(request.init.body))
    forms.push(form)
    return respond(form)
  })
  return forms
}

/** What an adapter call failed with. Adapter methods may answer synchronously or with a promise. */
function failure(operation: unknown): Promise<unknown> {
  return Promise.resolve(operation).then(
    () => undefined,
    (error: unknown) => error
  )
}

async function kindOf(operation: unknown): Promise<ConnectorOAuthErrorKind> {
  const error = await failure(operation)
  expect(error).toBeInstanceOf(ConnectorOAuthError)
  return (error as ConnectorOAuthError).kind
}

describe("Microsoft delegated OAuth — configuration", () => {
  test("is an OAuth connector people can own; the app-only modes stay static", () => {
    const definition = defineConnector("outlook", connector(), { owners: ["user"] })
    expect(definition.owners).toEqual(["user"])
    expect(definition.adapter.authentication.type).toBe("oauth2")
    const app = microsoft({ auth: { tenantId: TENANT, clientId: CLIENT_ID, clientSecret: "s" } })
    expect("authentication" in app).toBe(false)
  })

  test("refuses shared authorities, missing scopes and .default", () => {
    for (const oauth of [
      { tenantId: "common" },
      { tenantId: "organizations" },
      { scopes: [] },
      { scopes: ["https://graph.microsoft.com/.default"] },
      { clientSecret: " " },
    ]) {
      expect(() => connector(oauth)).toThrow(MicrosoftConfigurationError)
    }
  })
})

describe("Microsoft delegated OAuth — authorization", () => {
  test("asks the tenant for the Graph permissions, a refresh token and PKCE", async () => {
    const url = new URL(
      await connector().authentication.authorizationUrl(AUTHORIZATION_CONTEXT, {
        state: "state-1",
        codeChallenge: "challenge-1",
        codeChallengeMethod: "S256",
      })
    )
    expect(`${url.origin}${url.pathname}`).toBe(`${ENDPOINT}/authorize`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: "code",
      response_mode: "query",
      redirect_uri: AUTHORIZATION_CONTEXT.redirectUri,
      scope: "Mail.Read Calendars.Read openid profile offline_access User.Read",
      state: "state-1",
      prompt: "select_account",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    })
  })

  test("redeems the code as a confidential client", async () => {
    const forms = tokenEndpoint(() =>
      json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        scope: "https://graph.microsoft.com/Mail.Read calendars.read User.Read profile openid",
      })
    )
    const credentials = await connector().authentication.exchangeCode(AUTHORIZATION_CONTEXT, {
      code: "code-1",
      codeVerifier: "verifier-1",
    })
    expect(Object.fromEntries(forms[0]!)).toEqual({
      client_id: CLIENT_ID,
      client_secret: OAUTH.clientSecret,
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: AUTHORIZATION_CONTEXT.redirectUri,
      scope: "Mail.Read Calendars.Read openid profile offline_access User.Read",
      code_verifier: "verifier-1",
    })
    expect(credentials).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" })
    expect(credentials.expiresAt).toBeInstanceOf(Date)
  })

  test("refuses a grant without a refresh token or without a requested permission", async () => {
    tokenEndpoint(() => json({ access_token: "access-1", scope: "Mail.Read Calendars.Read" }))
    expect(
      await kindOf(
        connector().authentication.exchangeCode(AUTHORIZATION_CONTEXT, { code: "code-1" })
      )
    ).toBe("terminal")

    tokenEndpoint(() =>
      json({ access_token: "access-1", refresh_token: "refresh-1", scope: "Mail.Read User.Read" })
    )
    const missing = await failure(
      connector().authentication.exchangeCode(AUTHORIZATION_CONTEXT, { code: "code-1" })
    )
    expect(String(missing)).toContain("not granted Calendars.Read")
  })
})

describe("Microsoft delegated OAuth — refresh", () => {
  const credentials = { accessToken: "old-access", refreshToken: "old-refresh" }

  test("stores the new refresh token Entra issues on every refresh", async () => {
    const forms = tokenEndpoint(() =>
      json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 })
    )
    expect(await connector().authentication.refresh(CONTEXT, credentials)).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    })
    expect(forms[0]!.get("grant_type")).toBe("refresh_token")
    expect(forms[0]!.get("refresh_token")).toBe("old-refresh")

    tokenEndpoint(() => json({ access_token: "access-3", expires_in: 3600 }))
    expect(await connector().authentication.refresh(CONTEXT, credentials)).toMatchObject({
      refreshToken: "old-refresh",
    })
  })

  test("only a grant the person must renew needs reconnecting", async () => {
    // Removal proof: return "terminal" for every 4xx in rejectionKind; invalid_client then
    // disconnects every account.
    const cases: [Response | Error, ConnectorOAuthErrorKind][] = [
      [json({ error: "invalid_grant", error_codes: [700082] }, 400), "terminal"],
      [json({ error: "interaction_required", error_codes: [50076] }, 400), "terminal"],
      [json({ error: "invalid_client", error_codes: [7000215] }, 401), "retryable"],
      [json({ error: "temporarily_unavailable" }, 503), "retryable"],
      [new TypeError("socket hang up"), "retryable"],
    ]
    for (const [outcome, kind] of cases) {
      mockFetch(() => {
        if (outcome instanceof Error) throw outcome
        return outcome
      })
      expect(await kindOf(connector().authentication.refresh(CONTEXT, credentials))).toBe(kind)
    }
  })

  test("reports Entra's code without its description", async () => {
    tokenEndpoint(() =>
      json(
        {
          error: "invalid_grant",
          error_description: "AADSTS700082: The refresh token has expired. Trace ID: secret",
          error_codes: [700082],
        },
        400
      )
    )
    const error = await failure(connector().authentication.refresh(CONTEXT, credentials))
    expect(String(error)).toContain("invalid_grant, AADSTS700082")
    expect(String(error)).not.toContain("Trace ID")
  })
})

describe("Microsoft delegated OAuth — account and client", () => {
  test("discovers the account people sign in with", async () => {
    const requests = mockFetch(() =>
      json({
        id: "oid-ada",
        userPrincipalName: "ada@example.com",
        mail: "ada.lovelace@example.com",
        displayName: "Ada Lovelace",
      })
    )
    const accounts = await connector().discoverAccounts(CONTEXT, { accessToken: "access-1" })
    expect(accounts).toEqual([
      { id: "oid-ada", label: "ada@example.com", description: "Ada Lovelace" },
    ])
    expect(requests[0]!.url).toStartWith(`${GRAPH}me?`)
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer access-1")

    mockFetch(() => json({ error: { code: "InvalidAuthenticationToken" } }, 401))
    expect(await kindOf(connector().discoverAccounts(CONTEXT, { accessToken: "x" }))).toBe(
      "terminal"
    )
  })

  test("sends the connection's token and invalidates exactly the one Graph rejects", async () => {
    const invalidated: string[] = []
    let issued = 0
    const tokenSource = {
      async get(): Promise<ConnectorAccessToken> {
        const accessToken = `token-${++issued}`
        return { accessToken, invalidate: () => invalidated.push(accessToken) }
      },
    }
    const context: ConnectorConnectionClientContext = {
      ...CONTEXT,
      connectionId: "ccn_1",
      account: { id: "oid-ada", label: "ada@example.com" },
      tokenSource,
    }
    const seen: (string | null)[] = []
    mockFetch((request) => {
      seen.push(request.headers.get("authorization"))
      return seen.length === 1
        ? json({ error: { code: "InvalidAuthenticationToken" } }, 401)
        : json({ value: [] })
    })
    const client = await connector().connect(context)
    await client.mail.messages.list("oid-ada")
    expect(seen).toEqual(["Bearer token-1", "Bearer token-2"])
    expect(invalidated).toEqual(["token-1"])
  })
})
