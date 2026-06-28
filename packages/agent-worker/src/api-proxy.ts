import { isAllowedAgentApiRequest, normalizePath } from "./api-routes"
import { normalizeApiBaseUrl } from "./api-url"

const PROXY_HOSTNAME = "127.0.0.1"
const MAX_PROXY_REQUEST_BYTES = 1_000_000
const MAX_PROXY_RESPONSE_BYTES = 4_000_000

export interface AgentApiProxy {
  readonly baseUrl: string
  stop(): Promise<void>
}

export interface StartAgentApiProxyInput {
  readonly apiBaseUrl: string
  readonly accessToken: string
  readonly runId: string
}

export function startAgentApiProxy(input: StartAgentApiProxyInput): AgentApiProxy {
  const upstreamBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl)
  const server = Bun.serve({
    hostname: PROXY_HOSTNAME,
    port: 0, // picks a random port
    async fetch(request) {
      return proxyAgentApiRequest(request, {
        accessToken: input.accessToken,
        apiBaseUrl: upstreamBaseUrl,
        runId: input.runId,
      })
    },
  })
  const port = server.port
  if (port === undefined) {
    server.stop(true)
    throw new Error("[SixbAgentWorker] Could not start agent API proxy.")
  }

  return {
    baseUrl: `http://${PROXY_HOSTNAME}:${port}`,
    async stop() {
      await server.stop(true)
    },
  }
}

async function proxyAgentApiRequest(
  request: Request,
  input: StartAgentApiProxyInput
): Promise<Response> {
  const requestUrl = new URL(request.url)
  const method = request.method.toUpperCase()
  const pathname = normalizePath(requestUrl.pathname)

  if (!isAllowedAgentApiRequest(method, pathname)) {
    return jsonError(403, `Agent API proxy does not allow ${method} ${pathname}.`)
  }

  try {
    const body = await readBody(request, MAX_PROXY_REQUEST_BYTES)
    const upstreamUrl = new URL(`${pathname}${requestUrl.search}`, input.apiBaseUrl)
    const upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders(request.headers, input.accessToken),
      body,
      signal: request.signal,
    })
    const responseBody = await readBody(upstreamResponse, MAX_PROXY_RESPONSE_BYTES)
    return new Response(responseBody, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders(upstreamResponse.headers),
    })
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonError(413, error.message)
    }
    console.error(
      `[SixbAgentWorker] agent API proxy ${input.runId} ${method} ${pathname} failed:`,
      error
    )
    return jsonError(502, "Agent API proxy could not reach the Sixb API.")
  }
}

function upstreamHeaders(headers: Headers, accessToken: string): Headers {
  const next = new Headers(headers)
  for (const header of [
    "authorization",
    "cookie",
    "host",
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-csrf-token",
  ]) {
    next.delete(header)
  }
  next.set("authorization", `Bearer ${accessToken}`)
  return next
}

function responseHeaders(headers: Headers): Headers {
  const next = new Headers(headers)
  for (const header of [
    "connection",
    "content-encoding",
    "content-length",
    "set-cookie",
    "transfer-encoding",
  ]) {
    next.delete(header)
  }
  return next
}

async function readBody(input: Request | Response, maxBytes: number): Promise<Blob | undefined> {
  const contentLength = input.headers.get("content-length")
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new PayloadTooLargeError(`Agent API proxy body exceeds ${maxBytes} bytes.`)
  }
  if (!input.body) {
    return undefined
  }

  const body = await input.blob()
  if (body.size > maxBytes) {
    throw new PayloadTooLargeError(`Agent API proxy body exceeds ${maxBytes} bytes.`)
  }
  return body.size === 0 ? undefined : body
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

class PayloadTooLargeError extends Error {}
