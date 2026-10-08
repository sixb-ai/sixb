/**
 * End-to-end check of Sixb-managed Google OAuth against the real Google endpoints.
 *
 * Not part of `bun test` (it needs a Google OAuth client and, once, a person in a browser).
 * Run it from the repository root so Bun loads `.env.local`:
 *
 *   GOOGLE_OAUTH_CLIENT_ID="…apps.googleusercontent.com"
 *   GOOGLE_OAUTH_CLIENT_SECRET="…"
 *   GOOGLE_OAUTH_SCOPES="https://www.googleapis.com/auth/calendar.readonly …"   (optional)
 *   GOOGLE_OAUTH_HOSTED_DOMAIN="example.com"                                    (optional)
 *   GOOGLE_OAUTH_REDIRECT_URI="http://localhost:3000/auth/connectors/callback"  (default)
 *
 *   bun connectors/google/tests/oauth.e2e.ts
 *
 * The OAuth client must be a "Web application" client that lists the redirect URI exactly, and the
 * Google Cloud project must enable the API behind every scope.
 *
 * Without `GOOGLE_OAUTH_REFRESH_TOKEN`, the script prints an authorization URL and waits on the
 * redirect URI for the callback: consent, PKCE code exchange, and account discovery. It saves the
 * resulting refresh token to `.env.local` (never printing it), so later runs skip the browser. Set
 * `GOOGLE_OAUTH_CONSENT=1` to authorize again. While an External OAuth app is in Testing, Google
 * expires that refresh token after 7 days.
 *
 * Every run then checks refresh, account discovery, API calls through `connect()` including the
 * 401 retry with a fresh token, and how refresh failures are classified.
 */
import {
  type ConnectorAccessToken,
  type ConnectorOAuthCredentials,
  ConnectorOAuthError,
} from "@sixb/core"
import { google } from "../src/google"

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error(
    "Missing env. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (for example in\n" +
      ".env.local). See the header of this file for the OAuth client setup."
  )
  process.exit(1)
}

const scopes = (
  process.env.GOOGLE_OAUTH_SCOPES ??
  "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly"
)
  .split(/\s+/)
  .filter(Boolean)
const hostedDomain = process.env.GOOGLE_OAUTH_HOSTED_DOMAIN || undefined
const redirectUri = new URL(
  process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://localhost:3000/auth/connectors/callback"
)
const oauth = { clientId, clientSecret, scopes, ...(hostedDomain ? { hostedDomain } : {}) }
const connector = google({ auth: { oauth } })
const context = { projectId: "e2e", connectorId: "google", signal: new AbortController().signal }

const savedRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN
const credentials: ConnectorOAuthCredentials =
  savedRefreshToken && process.env.GOOGLE_OAUTH_CONSENT !== "1"
    ? { accessToken: "expired", refreshToken: savedRefreshToken }
    : await authorize()

console.log("\nRefreshing the access token …")
const refreshed = await connector.authentication.refresh(context, credentials)
check(refreshed.accessToken.length > 0, "refresh returned an access token")
check(refreshed.refreshToken === undefined, "Google did not rotate the refresh token")
check((refreshed.expiresAt?.getTime() ?? 0) > Date.now(), "the access token has a future expiry")
const granted = new Set(refreshed.scopes ?? [])
console.log(`Granted scopes: ${[...granted].join(" ")}`)

console.log("\nDiscovering the account …")
const [account] = await connector.discoverAccounts(context, refreshed)
check(account !== undefined, "account discovery returned the consenting account")
console.log(`Account: ${account?.label} (${account?.description ?? "no profile name"})`)

console.log("\nCalling Google APIs through connect() …")
// The first request carries a rejected token; the client must invalidate exactly that token and
// retry once with the next one.
const invalidated: string[] = []
let issued = 0
const client = await connector.connect({
  ...context,
  connectionId: "e2e",
  account: account ?? { id: "unknown", label: "unknown" },
  tokenSource: {
    async get(): Promise<ConnectorAccessToken> {
      const accessToken = issued++ === 0 ? "ya29.rejected-by-google" : refreshed.accessToken
      return { accessToken, invalidate: () => invalidated.push(accessToken) }
    },
  },
})

let calls = 0
if (granted.has("https://www.googleapis.com/auth/gmail.readonly")) {
  const profile = await client.gmail.users.getProfile("me")
  console.log(`Gmail: ${profile.messagesTotal ?? 0} messages in ${profile.emailAddress}`)
  calls++
}
if (granted.has("https://www.googleapis.com/auth/calendar.readonly")) {
  const calendars = await client.calendar.calendarList.list({ maxResults: 5 })
  console.log(`Calendar: ${calendars.items?.length ?? 0} calendar(s) on the first page`)
  calls++
}
if (granted.has("https://www.googleapis.com/auth/drive.readonly")) {
  const files = await client.drive.files.list({ pageSize: 5, fields: "files(id)" })
  console.log(`Drive: ${files.files?.length ?? 0} file(s) on the first page`)
  calls++
}
check(calls > 0, "at least one granted scope has an API call in this script")
check(
  invalidated.length === 1 && invalidated[0] === "ya29.rejected-by-google",
  "a 401 invalidated only the rejected token, and the retry succeeded"
)

console.log("\nClassifying refresh failures …")
check(
  (await refreshFailureKind(connector, { accessToken: "x", refreshToken: "1//revoked" })) ===
    "terminal",
  "an unknown refresh token (invalid_grant) requires reauthorization"
)
check(
  (await refreshFailureKind(
    google({ auth: { oauth: { ...oauth, clientSecret: "wrong-secret" } } }),
    credentials
  )) === "retryable",
  "a wrong client secret (invalid_client) keeps the grant"
)

console.log("\nE2E OK.")
process.exit(0)

async function authorize(): Promise<ConnectorOAuthCredentials> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  )
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)))
  const authorizationContext = { ...context, redirectUri: redirectUri.href }

  const callback = Promise.withResolvers<URLSearchParams>()
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port: Number(redirectUri.port || 80),
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== redirectUri.pathname) return new Response("Not found", { status: 404 })
        callback.resolve(url.searchParams)
        return new Response("Google authorization received. You can close this tab.")
      },
    })
  } catch (error) {
    throw new Error(
      `Could not listen on ${redirectUri.origin}; stop whatever uses that port (such as a Sixb dev server) and run again.`,
      { cause: error }
    )
  }

  const authorizationUrl = await connector.authentication.authorizationUrl(authorizationContext, {
    state,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  })
  console.log(`\nOpen this URL in a browser and approve every permission:\n\n${authorizationUrl}\n`)

  const timeout = setTimeout(
    () => callback.reject(new Error("No Google callback within 10 minutes.")),
    10 * 60_000
  )
  const parameters = await callback.promise.finally(() => {
    clearTimeout(timeout)
    server.stop()
  })
  const error = parameters.get("error")
  if (error) throw new Error(`Google returned an authorization error: ${error}`)
  check(parameters.get("state") === state, "the callback carries the authorization state")
  const code = parameters.get("code")
  if (!code) throw new Error("The Google callback carried no authorization code.")

  console.log("Exchanging the authorization code with the PKCE verifier …")
  const exchanged = await connector.authentication.exchangeCode(authorizationContext, {
    code,
    codeVerifier: verifier,
  })
  check(exchanged.refreshToken !== undefined, "Google issued a refresh token")
  await saveRefreshToken(exchanged.refreshToken as string)
  return exchanged
}

async function saveRefreshToken(refreshToken: string): Promise<void> {
  const file = Bun.file(".env.local")
  const text = (await file.exists()) ? await file.text() : ""
  const line = `GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}`
  const pattern = /^GOOGLE_OAUTH_REFRESH_TOKEN=.*$/m
  const next = pattern.test(text)
    ? text.replace(pattern, () => line)
    : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`
  await Bun.write(".env.local", next)
  console.log("Saved GOOGLE_OAUTH_REFRESH_TOKEN to .env.local.")
}

async function refreshFailureKind(
  adapter: typeof connector,
  input: ConnectorOAuthCredentials
): Promise<string> {
  try {
    await adapter.authentication.refresh(context, input)
    return "succeeded"
  } catch (error) {
    if (!(error instanceof ConnectorOAuthError)) throw error
    console.log(`  ${error.message}`)
    return error.kind
  }
}

function check(condition: boolean, description: string): void {
  if (!condition) throw new Error(`E2E check failed: ${description}`)
  console.log(`  ok — ${description}`)
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}
