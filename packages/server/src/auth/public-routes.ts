import { AGENT_API_GATEWAY_PREFIX } from "@sixb/core/internal/agents"
import { isCsrfExemptMethod } from "@sixb/core/internal/auth"

export type RouteAccessKind = "public" | "shared" | "api" | "html" | "websocket"

export interface RouteAccess {
  readonly kind: RouteAccessKind
  readonly csrfProtected: boolean
}

export function classifyRoute(request: Request): RouteAccess {
  const url = new URL(request.url)
  const { pathname } = url

  if (isPublicRoute(pathname, request.method)) {
    return { kind: "public", csrfProtected: false }
  }

  // Shared routes have their own cookie, CSRF boundary, and guard. Treating them as a distinct
  // class prevents ambient OIDC or access-token authority from leaking into shared execution.
  if (pathname.startsWith("/api/shares/")) {
    return { kind: "shared", csrfProtected: false }
  }

  if (pathname.startsWith("/ws/")) {
    return { kind: "websocket", csrfProtected: false }
  }

  if (pathname.startsWith("/api/")) {
    return { kind: "api", csrfProtected: !isCsrfExemptMethod(request.method) }
  }

  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    return { kind: "html", csrfProtected: !isCsrfExemptMethod(request.method) }
  }

  // Unreachable today — every registered route matches a branch above, and an unregistered
  // path 404s before these hooks run. It defaults to `api` so the next route mounted outside
  // those prefixes is protected until someone puts it on the allow-list, not the reverse.
  return { kind: "api", csrfProtected: !isCsrfExemptMethod(request.method) }
}

export function isPublicRoute(pathname: string, method: string): boolean {
  const normalizedMethod = method.toUpperCase()

  if (normalizedMethod === "OPTIONS") {
    return true
  }

  if ((pathname === "/favicon.svg" || pathname === "/favicon.ico") && normalizedMethod === "GET") {
    return true
  }

  if ((pathname === "/health" || pathname === "/ready") && normalizedMethod === "GET") {
    return true
  }

  // The gateway authenticates each request with the run's own execution token.
  if (pathname.startsWith(`${AGENT_API_GATEWAY_PREFIX}/`)) {
    return true
  }

  // Public because a webhook cannot carry a session: the signature its connector
  // verifies is the credential. POST only — `WebhookDefinition.method` is the literal
  // `"POST"`, so nothing else is ever registered here, and the allow-list should not be
  // wider than what it allows.
  if (pathname.startsWith("/api/webhooks/") && normalizedMethod === "POST") {
    return true
  }

  if (pathname === "/api/auth/session" && normalizedMethod === "GET") {
    return true
  }

  if (pathname === "/api/auth/sign-out" && normalizedMethod === "POST") {
    return true
  }

  if (pathname === "/auth/sign-in" && (normalizedMethod === "GET" || normalizedMethod === "POST")) {
    return true
  }

  // GET renders the magic-link confirmation page; POST consumes the emailed
  // token. The token itself is the credential, and no CSRF cookie exists yet.
  if (
    pathname === "/auth/callback" &&
    (normalizedMethod === "GET" || normalizedMethod === "POST")
  ) {
    return true
  }

  return false
}
