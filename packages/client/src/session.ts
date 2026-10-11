import { normalizeSixbApiBaseUrl } from "./base-url"

/** A native client's session tokens. Keep them in secure storage and never log them. */
export interface SixbSessionTokens {
  readonly accessToken: string
  readonly refreshToken: string
  /** ISO time the access token expires. */
  readonly accessExpiresAt: string
}

/** Where a native client keeps its session between launches, such as a 0600 file. */
export interface SixbSessionStore {
  load(): Promise<SixbSessionTokens | null> | SixbSessionTokens | null
  save(tokens: SixbSessionTokens): Promise<void> | void
  clear(): Promise<void> | void
}

/** The session was signed out, revoked, or left unused past its idle timeout. Sign in again. */
export class SixbSessionEndedError extends Error {
  override readonly name = "SixbSessionEndedError"
}

export interface SixbSessionRequestOptions {
  readonly baseUrl: string
  readonly fetch?: typeof fetch
}

export interface SixbSessionOptions extends SixbSessionRequestOptions {
  readonly store: SixbSessionStore
  /** Called once when the session ends; the store has been cleared. Sign the user in again. */
  readonly onSessionEnded?: () => void
}

export interface SixbDeviceLogin {
  /** Show this to the user; the approval page shows the same code. */
  readonly userCode: string
  /** Open this in a browser. It carries the code, so the user only confirms. */
  readonly verificationUriComplete: string
  readonly verificationUri: string
  readonly expiresAt: string
  /** Poll until the user approves in the browser, then return the new session's tokens. */
  complete(options?: { readonly signal?: AbortSignal }): Promise<SixbSessionTokens>
}

/** A sign-in code from another device, as a `sixb://connect` link carries it. */
export interface SixbSignInLink {
  /** The API the code signs in to. */
  readonly baseUrl: string
  readonly code: string
}

// Refresh this long before the access token expires, so no request goes out with one about to lapse.
const REFRESH_MARGIN_MS = 60_000

// One refresh per store at a time: concurrent requests share it, since each refresh retires the
// refresh token the others would present.
const refreshing = new WeakMap<SixbSessionStore, Promise<SixbSessionTokens>>()

/** Ask the API to sign this device in. Open `verificationUriComplete`, then await `complete()`. */
export async function startSixbDeviceLogin(
  options: SixbSessionRequestOptions & { readonly clientName: string }
): Promise<SixbDeviceLogin> {
  const post = sessionRequester(options)
  const response = await post("/api/auth/device-authorizations", {
    clientName: options.clientName,
  })
  if (!response.ok) throw await requestError(response, "start device login")

  const body = asRecord(await response.json())
  const deviceCode = nonblank(body.deviceCode)
  const userCode = nonblank(body.userCode)
  const verificationUri = nonblank(body.verificationUri)
  const verificationUriComplete = nonblank(body.verificationUriComplete)
  const expiresAt = nonblank(body.expiresAt)
  const interval = body.interval
  if (
    !deviceCode ||
    !userCode ||
    !verificationUri ||
    !verificationUriComplete ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    typeof interval !== "number" ||
    !Number.isFinite(interval)
  ) {
    throw new Error("[SixbClient] The Sixb API returned an invalid device login.")
  }
  // The user approves on this page while signed in, so it must be the API the device signs in to.
  if (new URL(verificationUriComplete).origin !== new URL(apiBase(options.baseUrl)).origin) {
    throw new Error("[SixbClient] The device login page is not on the Sixb API origin.")
  }

  const intervalMs = Math.max(1, Math.min(10, interval)) * 1000
  return {
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresAt,
    async complete({ signal } = {}) {
      while (Date.now() < Date.parse(expiresAt)) {
        // Not `signal.throwIfAborted()`: some runtimes' AbortSignal polyfills lack it.
        if (signal?.aborted)
          throw signal.reason ?? new Error("[SixbClient] Device login was aborted.")
        const poll = await post("/api/auth/device-authorizations/token", { deviceCode }, signal)
        if (!poll.ok) throw await requestError(poll, "complete device login")
        const result = asRecord(await poll.json())
        if (result.status === "approved") return parseSessionTokens(result)
        if (result.status === "denied") throw new Error("[SixbClient] Device login was denied.")
        if (result.status === "expired") break
        if (result.status !== "pending") {
          throw new Error("[SixbClient] The Sixb API returned an unknown device login status.")
        }
        await sleep(intervalMs, signal)
      }
      throw new Error("[SixbClient] Device login expired. Start it again.")
    },
  }
}

/** Trade a refresh token for new tokens. Throws `SixbSessionEndedError` when the session is gone. */
async function refreshSixbSession(
  options: SixbSessionRequestOptions & { readonly refreshToken: string }
): Promise<SixbSessionTokens> {
  const post = sessionRequester(options)
  const response = await post("/api/auth/refresh", { refreshToken: options.refreshToken })
  if (response.status === 401) throw sessionEnded()
  if (!response.ok) throw await requestError(response, "refresh the session")
  return parseSessionTokens(await response.json())
}

/**
 * The stored session's access token, refreshed and saved first when it is about to expire. Null
 * when the store holds no session. A session that has ended clears the store and throws
 * `SixbSessionEndedError`.
 */
export async function getSixbSessionAccessToken(
  options: SixbSessionOptions
): Promise<string | null> {
  const tokens = await options.store.load()
  if (!tokens) return null
  const remainingMs = Date.parse(tokens.accessExpiresAt) - Date.now()
  if (remainingMs > REFRESH_MARGIN_MS) return tokens.accessToken
  try {
    return (await renewSession(options, tokens)).accessToken
  } catch (error) {
    // An early refresh that fails for a transient reason (offline, server error) must not fail a
    // request the current token can still make.
    if (!(error instanceof SixbSessionEndedError) && remainingMs > 0) return tokens.accessToken
    throw error
  }
}

const SIGN_IN_LINK_PREFIX = "sixb://connect?"

/**
 * Read a scanned sign-in link: `sixb://connect?api=<API origin>&code=<code>`, the link a signed-in
 * browser shows as a QR code under "Sign in on another device". Anything else is null.
 */
export function parseSixbSignInLink(value: string): SixbSignInLink | null {
  const link = value.trim()
  // Parsed by hand: URL support for custom schemes varies across the runtimes that scan these.
  if (!link.toLowerCase().startsWith(SIGN_IN_LINK_PREFIX)) return null
  const params = new URLSearchParams(link.slice(SIGN_IN_LINK_PREFIX.length))
  const baseUrl = nonblank(params.get("api"))
  const code = nonblank(params.get("code"))
  if (!baseUrl || !code || !/^https?:\/\//i.test(baseUrl)) return null
  return { baseUrl, code }
}

/**
 * Sign this device in with a code from another device's signed-in browser. A code works once, for a
 * couple of minutes; `clientName` names the new session on the user's sessions list.
 */
export async function exchangeSixbSignInCode(
  options: SixbSessionRequestOptions & { readonly code: string; readonly clientName: string }
): Promise<SixbSessionTokens> {
  const post = sessionRequester(options)
  const response = await post("/api/auth/device-authorizations/token", {
    deviceCode: options.code,
    clientName: options.clientName,
  })
  if (!response.ok) throw await requestError(response, "sign in with the code")
  const result = asRecord(await response.json())
  if (result.status === "approved") return parseSessionTokens(result)
  throw new Error(
    "[SixbClient] This sign-in code has expired or was already used. Show a new one and scan it again."
  )
}

/** End the stored session on the server, then clear the store. */
export async function signOutSixbSession(options: SixbSessionOptions): Promise<void> {
  let accessToken: string | null
  try {
    accessToken = await getSixbSessionAccessToken(options)
  } catch (error) {
    // A session that already ended leaves nothing to revoke.
    if (error instanceof SixbSessionEndedError) return
    throw error
  }
  if (accessToken) {
    const response = await (options.fetch ?? globalThis.fetch)(
      `${apiBase(options.baseUrl)}/api/auth/sign-out`,
      { method: "POST", headers: { authorization: `Bearer ${accessToken}` } }
    )
    // 401: the session already ended, which is what signing out wanted.
    if (!response.ok && response.status !== 401) throw await requestError(response, "sign out")
  }
  await options.store.clear()
}

/**
 * A fetch that sends the stored session's access token to the API origin, refreshing it before it
 * expires and once more when the API answers 401. Requests to other origins go out untouched.
 */
export function createSixbSessionFetch(options: SixbSessionOptions): typeof fetch {
  const base = options.fetch ?? globalThis.fetch
  const apiOrigin = new URL(apiBase(options.baseUrl)).origin
  const sessionFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const request = new Request(input, init)
    if (new URL(request.url).origin !== apiOrigin) return base.call(globalThis, request)

    const accessToken = await currentAccessToken(options)
    if (!accessToken) return base.call(globalThis, request)
    const retry = request.clone()
    const response = await base.call(globalThis, withBearer(request, accessToken))
    if (response.status !== 401) return response

    // The access token was rejected before its expiry, so the session may have been refreshed or
    // ended elsewhere. Retry once with whatever the store now holds, refreshing if nothing changed.
    const stored = await options.store.load()
    if (!stored) return response
    let next: SixbSessionTokens
    try {
      next = stored.accessToken === accessToken ? await renewSession(options, stored) : stored
    } catch (error) {
      if (error instanceof SixbSessionEndedError) return response
      throw error
    }
    return base.call(globalThis, withBearer(retry, next.accessToken))
  }
  return Object.assign(sessionFetch, { preconnect: base.preconnect })
}

async function currentAccessToken(options: SixbSessionOptions): Promise<string | null> {
  try {
    return await getSixbSessionAccessToken(options)
  } catch (error) {
    if (error instanceof SixbSessionEndedError) return null
    throw error
  }
}

function renewSession(
  options: SixbSessionOptions,
  stale: SixbSessionTokens
): Promise<SixbSessionTokens> {
  const pending = refreshing.get(options.store) ?? refreshStoredSession(options, stale)
  refreshing.set(options.store, pending)
  return pending
}

async function refreshStoredSession(
  options: SixbSessionOptions,
  stale: SixbSessionTokens
): Promise<SixbSessionTokens> {
  try {
    // Another caller, or another process sharing the store, may have rotated the tokens since
    // `stale` was read. Presenting a rotated refresh token later than the grace window would look
    // like a stolen copy and revoke the session.
    const latest = await options.store.load()
    if (!latest) throw sessionEnded()
    if (latest.refreshToken !== stale.refreshToken) return latest

    const tokens = await refreshSixbSession({ ...options, refreshToken: latest.refreshToken })
    await options.store.save(tokens)
    return tokens
  } catch (error) {
    if (error instanceof SixbSessionEndedError) {
      await options.store.clear()
      options.onSessionEnded?.()
    }
    throw error
  } finally {
    refreshing.delete(options.store)
  }
}

function sessionEnded(): SixbSessionEndedError {
  return new SixbSessionEndedError("[SixbClient] The session has ended. Sign in again.")
}

function withBearer(request: Request, accessToken: string): Request {
  const headers = new Headers(request.headers)
  headers.set("authorization", `Bearer ${accessToken}`)
  return new Request(request, { headers })
}

function sessionRequester(options: SixbSessionRequestOptions) {
  const base = apiBase(options.baseUrl)
  const request = options.fetch ?? globalThis.fetch
  return (path: string, body: unknown, signal?: AbortSignal) =>
    request(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
}

function apiBase(baseUrl: string): string {
  const normalized = normalizeSixbApiBaseUrl(baseUrl)
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error("[SixbClient] Session sign-in requires an absolute API base URL.")
  }
  return normalized
}

function parseSessionTokens(value: unknown): SixbSessionTokens {
  const body = asRecord(value)
  const accessToken = nonblank(body.accessToken)
  const refreshToken = nonblank(body.refreshToken)
  const expiresIn = body.expiresIn
  if (!accessToken || !refreshToken || typeof expiresIn !== "number" || !(expiresIn > 0)) {
    throw new Error("[SixbClient] The Sixb API returned invalid session tokens.")
  }
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }
}

async function requestError(response: Response, action: string): Promise<Error> {
  const body = asRecord(await response.json().catch(() => null))
  const detail = typeof body.error === "string" ? `: ${body.error}` : ""
  return new Error(`[SixbClient] Could not ${action} (HTTP ${response.status})${detail}.`)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function nonblank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
