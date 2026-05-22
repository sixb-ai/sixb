import { randomBytes, timingSafeEqual } from "node:crypto"
import { getCookie } from "./cookies"

export const CSRF_HEADER_NAME = "x-pario-csrf"

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url")
}

export function isCsrfExemptMethod(method: string): boolean {
  const normalized = method.toUpperCase()
  return normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS"
}

export function verifyDoubleSubmitCsrf(
  request: Request,
  options: { readonly cookieName: string; readonly headerName?: string }
): boolean {
  if (isCsrfExemptMethod(request.method)) {
    return true
  }

  const cookieValue = getCookie(request, options.cookieName)
  const headerValue = request.headers.get(options.headerName ?? CSRF_HEADER_NAME)

  if (!cookieValue || !headerValue) {
    return false
  }

  return safeEqual(cookieValue, headerValue)
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.length !== rightBytes.length) {
    return false
  }

  return timingSafeEqual(leftBytes, rightBytes)
}
