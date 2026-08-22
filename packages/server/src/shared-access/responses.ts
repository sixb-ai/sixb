import { resolveSharedAccessRoute } from "../auth/public-routes"
import { createUnexpectedRouteError } from "../utils/http"

interface SharedBoundaryErrorContext {
  readonly request: Request
  readonly code: string | number
  readonly error: unknown
}

/** Secures framework failures that happen before a shared route handler can run. */
export function sharedBoundaryErrorResponse(
  context: SharedBoundaryErrorContext
): Response | undefined {
  const route = resolveSharedAccessRoute(
    new URL(context.request.url).pathname,
    context.request.method
  )
  if (!route) return

  if (isRequestInputError(context)) {
    if (route.operationId === "exchangeSharedAccess") return sharedAccessUnavailableResponse()
    if (route.operationId === "getSharedAccessSession") return sharedUnauthenticatedResponse()
    if (route.operationId === "getSharedAccessResource") return sharedAccessUnavailableResponse()
    if (route.operationId === "requestSharedAccessAction") return sharedInvalidActionResponse()
    if (route.operationId === "signOutSharedAccess") return sharedSignedOutResponse()
  }

  return sharedInternalErrorResponse(context.error)
}

function isRequestInputError(context: SharedBoundaryErrorContext): boolean {
  if (context.code === "PARSE") return true
  if (context.code !== "VALIDATION" || !isRecord(context.error)) return false
  return ["body", "params", "query", "headers", "cookie"].includes(String(context.error.type))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function sharedAccessUnavailableResponse(setCookies: readonly string[] = []): Response {
  return sharedJsonResponse(
    {
      error: "Shared access is unavailable.",
      code: "share.access_unavailable",
    },
    401,
    setCookies
  )
}

export function sharedInvalidActionResponse(error = "Shared action request is invalid."): Response {
  return sharedJsonResponse({ error, code: "share.action_invalid" }, 400)
}

export function sharedActionUnavailableResponse(): Response {
  return sharedJsonResponse(
    { error: "Shared action is unavailable.", code: "share.action_unavailable" },
    403
  )
}

export function sharedResourceNotFoundResponse(): Response {
  return sharedJsonResponse(
    { error: "Shared resource not found.", code: "share.resource_not_found" },
    404
  )
}

export function sharedUnauthenticatedResponse(setCookies: readonly string[] = []): Response {
  return sharedJsonResponse({ authenticated: false as const }, 200, setCookies)
}

export function sharedSignedOutResponse(setCookies: readonly string[] = []): Response {
  return sharedJsonResponse({ signedOut: true as const }, 200, setCookies)
}

export function sharedInternalErrorResponse(error: unknown): Response {
  const safeError = createUnexpectedRouteError(error)
  return sharedJsonResponse({ error: safeError.message, code: safeError.code }, 500)
}

export function sharedJsonResponse(
  body: unknown,
  status: number,
  setCookies: readonly string[] = []
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
  })
  for (const cookie of setCookies) headers.append("set-cookie", cookie)
  return new Response(JSON.stringify(body), { status, headers })
}
