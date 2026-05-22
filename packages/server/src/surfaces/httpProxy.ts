import { isHtmlResponse } from "./runtimeConfig"

export async function proxyHttpRequest(request: Request, target: URL): Promise<Response> {
  try {
    return await fetch(createProxyRequest(request, target))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new Response(`[ParioServer] Upstream app request failed: ${message}`, {
      status: 502,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  }
}

export async function proxyPublicAppRequest(request: Request, target: URL): Promise<Response> {
  const response = await proxyHttpRequest(request, target)

  if (response.status >= 400) {
    return withNoStore(response)
  }

  if (response.status >= 200 && response.status < 300 && isHtmlResponse(response)) {
    return new Response("Not Found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  }

  return response
}

function createProxyRequest(request: Request, target: URL): Request {
  const headers = new Headers(request.headers)
  headers.delete("host")
  headers.delete("connection")
  headers.delete("upgrade")

  return new Request(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  })
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "no-store")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
