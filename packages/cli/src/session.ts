/**
 * Zero-dependency device login and session refresh for the Sixb CLI.
 * Speaks directly to `/api/auth/*` over `fetch`, so it runs identically on Bun and Node.
 */

export interface SixbSessionTokens {
  readonly accessToken: string
  readonly refreshToken: string
  /** ISO timestamp when the access token expires. */
  readonly accessExpiresAt: string
}

export interface SixbSessionStore {
  load(): Promise<SixbSessionTokens | null> | SixbSessionTokens | null
  save(tokens: SixbSessionTokens): Promise<void> | void
  clear(): Promise<void> | void
}

export class SixbSessionEndedError extends Error {
  override readonly name = "SixbSessionEndedError"
}

export interface SixbDeviceLogin {
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string
  readonly expiresAt: string
  complete(options?: { readonly signal?: AbortSignal }): Promise<SixbSessionTokens>
}

const REFRESH_MARGIN_MS = 60_000
const refreshing = new WeakMap<SixbSessionStore, Promise<SixbSessionTokens>>()

export function normalizeApiUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("unix:")) {
    const socketPath = trimmed.slice("unix:".length)
    if (!socketPath) {
      throw new Error(
        `[SixbCLI] Invalid API URL '${value}'. Use a full http(s) URL or unix:<path>.`
      )
    }
    return trimmed
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`[SixbCLI] Invalid API URL '${value}'. Use a full http(s) URL.`)
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`[SixbCLI] Invalid API URL '${value}'. Use a full http(s) URL.`)
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "")
  return `${url.origin}${pathname}`
}

export async function startDeviceLogin(options: {
  readonly baseUrl: string
  readonly clientName: string
}): Promise<SixbDeviceLogin> {
  const baseUrl = normalizeApiUrl(options.baseUrl)
  const response = await postJson(baseUrl, "/api/auth/device-authorizations", {
    clientName: options.clientName,
  })
  if (!response.ok) throw await responseError(response, "start device login")

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
    throw new Error("[SixbCLI] The Sixb API returned an invalid device login response.")
  }
  if (new URL(verificationUriComplete).origin !== new URL(baseUrl).origin) {
    throw new Error("[SixbCLI] The device login page is not on the Sixb API origin.")
  }

  const intervalMs = Math.max(1, Math.min(10, interval)) * 1000
  return {
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresAt,
    async complete({ signal } = {}) {
      while (Date.now() < Date.parse(expiresAt)) {
        signal?.throwIfAborted()
        const poll = await postJson(
          baseUrl,
          "/api/auth/device-authorizations/token",
          { deviceCode },
          signal
        )
        if (!poll.ok) throw await responseError(poll, "complete device login")
        const result = asRecord(await poll.json())
        if (result.status === "approved") return parseSessionTokens(result)
        if (result.status === "denied") throw new Error("[SixbCLI] Device login was denied.")
        if (result.status === "expired") break
        if (result.status !== "pending") {
          throw new Error("[SixbCLI] The Sixb API returned an unknown device login status.")
        }
        await sleep(intervalMs, signal)
      }
      throw new Error("[SixbCLI] Device login expired. Start it again.")
    },
  }
}

export async function getSessionAccessToken(options: {
  readonly baseUrl: string
  readonly store: SixbSessionStore
}): Promise<string | null> {
  const tokens = await options.store.load()
  if (!tokens) return null
  const remainingMs = Date.parse(tokens.accessExpiresAt) - Date.now()
  if (remainingMs > REFRESH_MARGIN_MS) return tokens.accessToken
  try {
    return (await renewSession(options, tokens)).accessToken
  } catch (error) {
    if (!(error instanceof SixbSessionEndedError) && remainingMs > 0) return tokens.accessToken
    throw error
  }
}

export async function signOutSession(options: {
  readonly baseUrl: string
  readonly store: SixbSessionStore
}): Promise<void> {
  let accessToken: string | null = null
  try {
    accessToken = await getSessionAccessToken(options)
  } catch (error) {
    if (error instanceof SixbSessionEndedError) return
  }
  const baseUrl = normalizeApiUrl(options.baseUrl)
  if (accessToken) {
    await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    }).catch(() => {})
  }
  await options.store.clear()
}

async function renewSession(
  options: { readonly baseUrl: string; readonly store: SixbSessionStore },
  current: SixbSessionTokens
): Promise<SixbSessionTokens> {
  const active = refreshing.get(options.store)
  if (active) return active

  const promise = (async () => {
    const baseUrl = normalizeApiUrl(options.baseUrl)
    const response = await postJson(baseUrl, "/api/auth/refresh", {
      refreshToken: current.refreshToken,
    })
    if (response.status === 401) {
      await options.store.clear()
      throw new SixbSessionEndedError("[SixbCLI] The session has ended. Sign in again.")
    }
    if (!response.ok) throw await responseError(response, "refresh the session")
    const next = parseSessionTokens(asRecord(await response.json()))
    await options.store.save(next)
    return next
  })()

  refreshing.set(options.store, promise)
  try {
    return await promise
  } finally {
    refreshing.delete(options.store)
  }
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
}

function parseSessionTokens(record: Readonly<Record<string, unknown>>): SixbSessionTokens {
  const accessToken = nonblank(record.accessToken)
  const refreshToken = nonblank(record.refreshToken)
  const accessExpiresAt = nonblank(record.accessExpiresAt)
  if (
    !accessToken ||
    !refreshToken ||
    !accessExpiresAt ||
    Number.isNaN(Date.parse(accessExpiresAt))
  ) {
    throw new Error("[SixbCLI] The Sixb API returned invalid session tokens.")
  }
  return { accessToken, refreshToken, accessExpiresAt }
}

async function responseError(response: Response, action: string): Promise<Error> {
  const text = await response.text().catch(() => "")
  try {
    const parsed = asRecord(JSON.parse(text))
    if (typeof parsed.error === "string" && parsed.error) {
      return new Error(`[SixbCLI] Failed to ${action}: ${parsed.error}`)
    }
  } catch {}
  return new Error(`[SixbCLI] Failed to ${action} (HTTP ${response.status}).`)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("Aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function nonblank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
