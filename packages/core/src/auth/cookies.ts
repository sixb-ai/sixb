import type { AuthSessionAudience } from "./audience"
import { DEFAULT_AUTH_SESSION_AUDIENCE, resolveAuthSessionAudience } from "./audience"
import type { AuthCookieOptions } from "./types"

export const DEFAULT_SESSION_COOKIE_NAME = "pario_session"
export const DEFAULT_CSRF_COOKIE_NAME = "pario_csrf"

export interface ResolvedAuthCookieOptions {
  readonly sessionCookieName: string
  readonly csrfCookieName: string
  readonly domain?: string
  readonly secure: boolean | "auto"
}

interface CookieSerializationOptions {
  readonly name: string
  readonly value: string
  readonly httpOnly?: boolean
  readonly maxAge?: number
  readonly expires?: Date
  readonly domain?: string
  readonly secure?: boolean
}

export function resolveAuthCookieOptions(
  options: AuthCookieOptions | undefined
): ResolvedAuthCookieOptions {
  return {
    sessionCookieName: options?.sessionCookieName ?? DEFAULT_SESSION_COOKIE_NAME,
    csrfCookieName: options?.csrfCookieName ?? DEFAULT_CSRF_COOKIE_NAME,
    domain: options?.cookieDomain,
    secure: options?.secure ?? "auto",
  }
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

  parts.push("Path=/")
  parts.push("SameSite=Lax")

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
  readonly maxAgeSeconds: number
  readonly options: ResolvedAuthCookieOptions
}): string {
  return serializeCookie({
    name: params.options.sessionCookieName,
    value: params.value,
    httpOnly: true,
    maxAge: params.maxAgeSeconds,
    domain: params.options.domain,
    secure: shouldUseSecureCookies(params.request, params.options),
  })
}

export function createCsrfCookieHeader(params: {
  readonly request: Request
  readonly value: string
  readonly maxAgeSeconds: number
  readonly options: ResolvedAuthCookieOptions
}): string {
  return serializeCookie({
    name: params.options.csrfCookieName,
    value: params.value,
    maxAge: params.maxAgeSeconds,
    domain: params.options.domain,
    secure: shouldUseSecureCookies(params.request, params.options),
  })
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
  })
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}
