import type { AuthSessionAudience } from "@sixb/core"
import type { SixbErrorCode } from "@sixb/core/errors"
import { statusForErrorCode } from "../utils/http"
import { returnToForRequest } from "./return-to"

export function jsonAuthRequiredResponse(): Response {
  return jsonErrorResponse("auth.authentication_required", "Authentication required")
}

export function jsonCsrfFailedResponse(): Response {
  return jsonErrorResponse("auth.csrf_rejected", "CSRF verification failed")
}

export function jsonForbiddenResponse(message = "Forbidden"): Response {
  return jsonErrorResponse("auth.permission_denied", message)
}

/** An error body and the status its code answers with, for the auth routes that build a `Response`. */
export function jsonErrorResponse(code: SixbErrorCode, message: string): Response {
  return jsonResponse({ error: message, code }, statusForErrorCode(code))
}

export function htmlAuthRedirectResponse(
  request: Request,
  options: {
    readonly absoluteReturnTo?: boolean
    readonly audience?: AuthSessionAudience
  } = {}
): Response {
  const requestUrl = new URL(request.url)
  const rawReturnTo = options.absoluteReturnTo
    ? new URL(returnToForRequest(request), requestUrl.origin).toString()
    : returnToForRequest(request)
  const params = new URLSearchParams({ returnTo: rawReturnTo })
  if (options.absoluteReturnTo && options.audience) {
    params.set("audience", options.audience)
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: `/auth/sign-in?${params.toString()}`,
      "cache-control": "no-store",
    },
  })
}

export function websocketAuthFailedResponse(): Response {
  return jsonAuthRequiredResponse()
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  })
}
