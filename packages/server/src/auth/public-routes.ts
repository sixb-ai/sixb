import { isCsrfExemptMethod } from "@sixb/core"

export type RouteAccessKind = "public" | "api" | "html" | "websocket"

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

  if (pathname.startsWith("/ws/")) {
    return { kind: "websocket", csrfProtected: false }
  }

  if (pathname.startsWith("/api/")) {
    return { kind: "api", csrfProtected: !isCsrfExemptMethod(request.method) }
  }

  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    return { kind: "html", csrfProtected: !isCsrfExemptMethod(request.method) }
  }

  return { kind: "public", csrfProtected: false }
}

export function isPublicRoute(pathname: string, method: string): boolean {
  const normalizedMethod = method.toUpperCase()

  if (normalizedMethod === "OPTIONS") {
    return true
  }

  if ((pathname === "/favicon.svg" || pathname === "/favicon.ico") && normalizedMethod === "GET") {
    return true
  }

  if (pathname.startsWith("/__sixb/") && normalizedMethod === "GET") {
    return true
  }

  if (pathname.startsWith("/api/webhooks/")) {
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

  if (pathname === "/auth/callback" && normalizedMethod === "GET") {
    return true
  }

  return false
}
