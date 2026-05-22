import { returnToForRequest } from "./return-to"

export function jsonAuthRequiredResponse(): Response {
  return jsonResponse({ error: "Authentication required" }, 401)
}

export function jsonCsrfFailedResponse(): Response {
  return jsonResponse({ error: "CSRF verification failed" }, 403)
}

export function htmlAuthRedirectResponse(request: Request): Response {
  const returnTo = encodeURIComponent(returnToForRequest(request))
  return new Response(null, {
    status: 302,
    headers: {
      location: `/auth/sign-in?returnTo=${returnTo}`,
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
