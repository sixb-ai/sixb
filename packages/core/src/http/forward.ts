/**
 * Forwards a request, or a WebSocket, to another server: a hosted branch's front to its API, and
 * production's server to a branch under its preview domain. Bodies stream both ways and are never
 * parsed or decompressed.
 */

/** Headers about one connection rather than the request: never passed on. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
])

export interface ForwardOptions {
  /** Which of the request's headers go on. Hop-by-hop headers never do. Default: all of them. */
  readonly requestHeaders?: (name: string) => boolean
  /** Which of the response's headers come back. Hop-by-hop headers never do. Default: all. */
  readonly responseHeaders?: (name: string) => boolean
  /** Added to the forwarded request, over any it carried. */
  readonly headers?: Readonly<Record<string, string>>
  /** Ends the forwarded request. Default: the incoming request's own. */
  readonly signal?: AbortSignal
}

/** Sends `request` to `target`, a full URL, and returns its response as it streams. */
export async function forwardRequest(
  request: Request,
  target: string,
  options: ForwardOptions = {}
): Promise<Response> {
  const headers = new Headers()
  request.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name) && (options.requestHeaders?.(name) ?? true)) {
      headers.set(name, value)
    }
  })
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)

  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    redirect: "manual",
    // Passed through as it came, so content-encoding and content-length stay true.
    decompress: false,
    signal: options.signal ?? request.signal,
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  } as RequestInit)

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name) && (options.responseHeaders?.(name) ?? true)) {
      if (name === "set-cookie") responseHeaders.append(name, value)
      else responseHeaders.set(name, value)
    }
  })
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

/** Handshake headers each WebSocket connection makes its own: never passed on. */
const HANDSHAKE = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
  "sec-websocket-protocol",
])

/** What a forwarded WebSocket opens its upstream side with. */
export interface ForwardedHandshake {
  readonly headers: Readonly<Record<string, string>>
  readonly protocols: readonly string[]
}

/**
 * What an upgrade request carries on to the socket it is forwarded to, as `forwardRequest` passes a
 * request's headers on: its cookies and its origin among them, which the server behind checks as
 * it checks any request. Its subprotocols go on as such; what belongs to one connection doesn't.
 */
export function forwardedHandshake(
  request: Request,
  keep: (name: string) => boolean = () => true
): ForwardedHandshake {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name) && !HANDSHAKE.has(name) && keep(name)) headers[name] = value
  })
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean)
  return { headers, protocols }
}

/** The side of a WebSocket this server holds open with its client. */
export interface ForwardedSocketClient {
  send(data: string | ArrayBuffer | Uint8Array): unknown
  close(code?: number, reason?: string): unknown
}

/** The upstream side of a forwarded WebSocket. */
export interface ForwardedSocket {
  /** Passes a client's message on, holding it until the upstream socket opens. */
  send(data: string | ArrayBuffer | Uint8Array): void
  /** Closes the upstream socket, after the client's. */
  close(code?: number, reason?: string): void
}

/**
 * Opens `target`, a `ws:` or `wss:` URL, for a client this server accepted. Messages pass both
 * ways; when either side closes, so does the other. A client that reconnects gets a new upstream
 * socket, so a restart upstream closes the client's and its own reconnect takes over.
 */
export function forwardWebSocket(
  client: ForwardedSocketClient,
  target: string,
  handshake: ForwardedHandshake = { headers: {}, protocols: [] }
): ForwardedSocket {
  const upstream = new WebSocket(target, {
    headers: { ...handshake.headers },
    ...(handshake.protocols.length > 0 ? { protocols: [...handshake.protocols] } : {}),
  } as never)
  upstream.binaryType = "arraybuffer"
  const pending: (string | ArrayBuffer | Uint8Array<ArrayBuffer>)[] = []
  let closed = false

  upstream.addEventListener("open", () => {
    for (const data of pending.splice(0)) upstream.send(data)
  })
  upstream.addEventListener("message", (event) => {
    client.send(event.data as string | ArrayBuffer)
  })
  upstream.addEventListener("close", (event) => {
    if (closed) return
    closed = true
    client.close(sendableCloseCode(event.code), event.reason)
  })
  upstream.addEventListener("error", () => {
    if (closed) return
    closed = true
    client.close(1011, "Upstream unavailable")
  })

  return {
    send(data) {
      if (closed) return
      // A copy, so a view over a shared buffer can't change after it's queued.
      const message =
        typeof data === "string" || data instanceof ArrayBuffer ? data : new Uint8Array(data)
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message)
      else pending.push(message)
    },
    close(code, reason) {
      if (closed) return
      closed = true
      try {
        upstream.close(code === undefined ? 1000 : sendableCloseCode(code), reason)
      } catch {
        upstream.close()
      }
    },
  }
}

/** 1005 (closed with no code) and 1006 (dropped) can be reported, never sent. */
function sendableCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code
  if (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code
  return code === 1005 ? 1000 : 1011
}
