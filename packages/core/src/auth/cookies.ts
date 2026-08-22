import type { AuthSessionAudience } from "./audience"
import { DEFAULT_AUTH_SESSION_AUDIENCE, resolveAuthSessionAudience } from "./audience"
import type { AuthCookieOptions } from "./types"

export const DEFAULT_SESSION_COOKIE_NAME = "sixb_session"
export const DEFAULT_CSRF_COOKIE_NAME = "sixb_csrf"

export interface ResolvedAuthCookieOptions {
  readonly sessionCookieName: string
  readonly csrfCookieName: string
  readonly domain?: string
  readonly secure: boolean | "auto"
  readonly sameSite: "strict"
  readonly csrfHttpOnly: boolean
}

interface CookieSerializationOptions {
  readonly name: string
  readonly value: string
  readonly path?: string
  readonly httpOnly?: boolean
  readonly maxAge?: number
  readonly expires?: Date
  readonly domain?: string
  readonly secure?: boolean
  readonly sameSite: "strict"
}

export function resolveAuthCookieOptions(
  options: AuthCookieOptions | undefined
): ResolvedAuthCookieOptions {
  const resolved = {
    sessionCookieName: options?.sessionCookieName ?? DEFAULT_SESSION_COOKIE_NAME,
    csrfCookieName: options?.csrfCookieName ?? DEFAULT_CSRF_COOKIE_NAME,
    domain: options?.cookieDomain,
    secure: options?.secure ?? "auto",
    sameSite: options?.sameSite ?? "strict",
    csrfHttpOnly: options?.csrfHttpOnly ?? false,
  }

  assertValidCookieOptions(resolved)
  return resolved
}

export function resolveAuthCookieOptionsForAudience(
  options: ResolvedAuthCookieOptions,
  audience: AuthSessionAudience | undefined
): ResolvedAuthCookieOptions {
  const resolvedAudience = resolveAuthSessionAudience(audience)
  if (resolvedAudience === DEFAULT_AUTH_SESSION_AUDIENCE) {
    return options
  }

  return {
    ...options,
    sessionCookieName: `${options.sessionCookieName}_${resolvedAudience}`,
    csrfCookieName: `${options.csrfCookieName}_${resolvedAudience}`,
  }
}

export function parseCookieHeader(header: string | null): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>()
  if (!header) {
    return cookies
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator <= 0) {
      continue
    }

    const name = part.slice(0, separator).trim()
    if (!name || cookies.has(name)) {
      continue
    }

    const value = part.slice(separator + 1).trim()
    cookies.set(name, value)
  }

  return cookies
}

export function getCookie(request: Request, name: string): string | undefined {
  return parseCookieHeader(request.headers.get("cookie")).get(name)
}

export function serializeCookie(options: CookieSerializationOptions): string {
  const parts = [`${options.name}=${options.value}`]

  parts.push(`Path=${options.path ?? "/"}`)
  parts.push("SameSite=Strict")

  if (options.domain) {
    parts.push(`Domain=${options.domain}`)
  }

  if (options.httpOnly) {
    parts.push("HttpOnly")
  }

  if (options.secure) {
    parts.push("Secure")
  }

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.trunc(options.maxAge)}`)
  }

  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`)
  }

  return parts.join("; ")
}

export function shouldUseSecureCookies(
  request: Request,
  options: ResolvedAuthCookieOptions
): boolean {
  if (
    requiresSecureCookieName(options.sessionCookieName) ||
    requiresSecureCookieName(options.csrfCookieName)
  ) {
    return true
  }

  if (typeof options.secure === "boolean") {
    return options.secure
  }

  const url = new URL(request.url)
  if (isLocalhost(url.hostname)) {
    return false
  }

  return url.protocol === "https:" || process.env.NODE_ENV === "production"
}

export function createSessionCookieHeader(params: {
  readonly request: Request
  readonly value: string
  readonly expiresAt: Date
  readonly options: ResolvedAuthCookieOptions
}): string {
  const lifetime = resolveCookieLifetime(params.expiresAt)
  return serializeCookie({
    name: params.options.sessionCookieName,
    value: params.value,
    httpOnly: true,
    ...lifetime,
    domain: params.options.domain,
    secure: shouldUseSecureCookies(params.request, params.options),
    sameSite: params.options.sameSite,
  })
}

export function createCsrfCookieHeader(params: {
  readonly request: Request
  readonly value: string
  readonly expiresAt: Date
  readonly options: ResolvedAuthCookieOptions
}): string {
  const lifetime = resolveCookieLifetime(params.expiresAt)
  return serializeCookie({
    name: params.options.csrfCookieName,
    value: params.value,
    httpOnly: params.options.csrfHttpOnly,
    ...lifetime,
    domain: params.options.domain,
    secure: shouldUseSecureCookies(params.request, params.options),
    sameSite: params.options.sameSite,
  })
}

function resolveCookieLifetime(expiresAt: Date): {
  readonly maxAge: number
  readonly expires: Date
} {
  const expiresAtMs = expiresAt.getTime()
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error("[Sixb] Auth cookie expiresAt must be a valid date.")
  }

  return {
    maxAge: Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
    expires: new Date(expiresAtMs),
  }
}

export function clearSessionCookieHeader(params: {
  readonly request: Request
  readonly options: ResolvedAuthCookieOptions
}): string {
  return serializeCookie({
    name: params.options.sessionCookieName,
    value: "",
    httpOnly: true,
    maxAge: 0,
    expires: new Date(0),
    domain: params.options.domain,
    secure: shouldUseSecureCookies(params.request, params.options),
    sameSite: params.options.sameSite,
  })
}

export function clearCsrfCookieHeader(params: {
  readonly request: Request
  readonly options: ResolvedAuthCookieOptions
}): string {
  return serializeCookie({
    name: params.options.csrfCookieName,
    value: "",
    maxAge: 0,
    expires: new Date(0),
    domain: params.options.domain,
    secure: shouldUseSecureCookies(params.request, params.options),
    sameSite: params.options.sameSite,
  })
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}

function assertValidCookieOptions(options: ResolvedAuthCookieOptions): void {
  assertValidCookieName(options.sessionCookieName, "sessionCookieName")
  assertValidCookieName(options.csrfCookieName, "csrfCookieName")

  if (options.sameSite !== "strict") {
    throw new Error("[Sixb] Auth cookie sameSite must be 'strict'.")
  }

  if (
    options.domain &&
    (isHostPrefixedCookieName(options.sessionCookieName) ||
      isHostPrefixedCookieName(options.csrfCookieName))
  ) {
    throw new Error("[Sixb] __Host- auth cookies cannot be configured with cookieDomain.")
  }

  if (
    options.secure === false &&
    (requiresSecureCookieName(options.sessionCookieName) ||
      requiresSecureCookieName(options.csrfCookieName))
  ) {
    throw new Error("[Sixb] __Host- auth cookies require secure cookies.")
  }
}

function assertValidCookieName(name: string, label: string): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new Error(`[Sixb] Auth cookie ${label} '${name}' is not a valid cookie name.`)
  }
}

function isHostPrefixedCookieName(name: string): boolean {
  return name.startsWith("__Host-")
}

function requiresSecureCookieName(name: string): boolean {
  return isHostPrefixedCookieName(name) || name.startsWith("__Secure-")
}
