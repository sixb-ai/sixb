import { randomBytes, timingSafeEqual } from "node:crypto"
import { getCookie } from "./cookies"

export const CSRF_HEADER_NAME = "x-sixb-csrf"

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url")
}

export function isCsrfExemptMethod(method: string): boolean {
  const normalized = method.toUpperCase()
  return normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS"
}

export function verifyDoubleSubmitCsrf(
  request: Request,
  options: { readonly cookieName: string }
): boolean {
  if (isCsrfExemptMethod(request.method)) {
    return true
  }

  return verifyCsrfToken(request, {
    cookieName: options.cookieName,
    token: request.headers.get(CSRF_HEADER_NAME),
  })
}

/** Match a submitted CSRF token (header or form field) against the request's CSRF cookie. */
export function verifyCsrfToken(
  request: Request,
  options: { readonly cookieName: string; readonly token: string | null }
): boolean {
  const cookieValue = getCookie(request, options.cookieName)
  if (!cookieValue || !options.token) {
    return false
  }

  return safeEqual(cookieValue, options.token)
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.length !== rightBytes.length) {
    return false
  }

  return timingSafeEqual(leftBytes, rightBytes)
}
