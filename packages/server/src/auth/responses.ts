import { returnToForRequest } from "./return-to"

export function jsonAuthRequiredResponse(): Response {
  return jsonResponse({ error: "Authentication required" }, 401)
}

export function jsonCsrfFailedResponse(): Response {
  return jsonResponse({ error: "CSRF verification failed" }, 403)
}

export function jsonForbiddenResponse(message = "Forbidden"): Response {
  return jsonResponse({ error: message }, 403)
}

export function htmlAuthRedirectResponse(
  request: Request,
  options: {
    readonly absoluteReturnTo?: boolean
    readonly audience?: string
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
