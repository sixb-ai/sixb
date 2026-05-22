const PROXY_SOCKET_KIND = "pario.customApp.wsProxy"
const MAX_BUFFERED_MESSAGES = 64

type WebSocketMessage = string | ArrayBuffer

interface ProxySocketData {
  readonly kind: typeof PROXY_SOCKET_KIND
  readonly target: string
}

interface BunServerLike {
  upgrade(request: Request, options: { readonly data: ProxySocketData }): boolean
}

interface BunWebSocketLike {
  readonly data?: unknown
  send(message: WebSocketMessage): number | undefined
  close(code?: number, reason?: string): void
}

interface ProxyState {
  readonly downstream: BunWebSocketLike
  readonly upstream: WebSocket
  readonly buffered: WebSocketMessage[]
  upstreamOpen: boolean
  closing: boolean
}

export interface WebSocketProxy {
  upgrade(request: Request, server: unknown, target: URL): Response | undefined
  isProxySocket(ws: unknown): boolean
  open(ws: unknown): void
  message(ws: unknown, message: unknown): void
  close(ws: unknown, code?: number, reason?: string): void
}

export function createWebSocketProxy(): WebSocketProxy {
  const states = new WeakMap<object, ProxyState>()

  function getState(ws: unknown): ProxyState | null {
    if (!isObject(ws)) {
      return null
    }

    return states.get(ws) ?? null
  }

  function closeBoth(state: ProxyState, code = 1011, reason = "WebSocket proxy closed") {
    if (state.closing) {
      return
    }

    state.closing = true
    try {
      state.upstream.close(code, reason)
    } catch {}
    try {
      state.downstream.close(code, reason)
    } catch {}
  }

  return {
    upgrade(request, server, target) {
      if (!isBunServer(server)) {
        return new Response("WebSocket Upgrade Failed", {
          status: 500,
          headers: { "cache-control": "no-store" },
        })
      }

      const accepted = server.upgrade(request, {
        data: {
          kind: PROXY_SOCKET_KIND,
          target: toWebSocketUrl(target).href,
        },
      })

      return accepted
        ? undefined
        : new Response("WebSocket Upgrade Failed", {
            status: 500,
            headers: { "cache-control": "no-store" },
          })
    },

    isProxySocket(ws) {
      return isProxySocketData(toBunWebSocket(ws).data)
    },

    open(ws) {
      const downstream = toBunWebSocket(ws)
      const data = downstream.data
      if (!isProxySocketData(data)) {
        downstream.close(1011, "Invalid WebSocket proxy state")
        return
      }

      const upstream = new WebSocket(data.target)
      upstream.binaryType = "arraybuffer"
      const state: ProxyState = {
        downstream,
        upstream,
        buffered: [],
        upstreamOpen: false,
        closing: false,
      }
      if (isObject(ws)) {
        states.set(ws, state)
      }

      upstream.addEventListener("open", () => {
        state.upstreamOpen = true
        for (const message of state.buffered.splice(0)) {
          upstream.send(message)
        }
      })

      upstream.addEventListener("message", (event) => {
        void sendDownstream(downstream, event.data)
      })

      upstream.addEventListener("close", (event) => {
        closeBoth(state, event.code || 1000, event.reason || "Upstream WebSocket closed")
      })

      upstream.addEventListener("error", () => {
        closeBoth(state, 1011, "Upstream WebSocket failed")
      })
    },

    message(ws, message) {
      const state = getState(ws)
      const normalized = normalizeMessage(message)
      if (!state || !normalized) {
        return
      }

      if (!state.upstreamOpen) {
        if (state.buffered.length >= MAX_BUFFERED_MESSAGES) {
          closeBoth(state, 1011, "WebSocket proxy buffer limit exceeded")
          return
        }

        state.buffered.push(normalized)
        return
      }

      state.upstream.send(normalized)
    },

    close(ws, code, reason) {
      const state = getState(ws)
      if (!state) {
        return
      }

      closeBoth(state, code ?? 1000, reason ?? "Downstream WebSocket closed")
      if (isObject(ws)) {
        states.delete(ws)
      }
    },
  }
}

function toWebSocketUrl(target: URL): URL {
  const url = new URL(target)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url
}

function toBunWebSocket(value: unknown): BunWebSocketLike {
  return value as BunWebSocketLike
}

function isBunServer(value: unknown): value is BunServerLike {
  return isObject(value) && "upgrade" in value && typeof value.upgrade === "function"
}

function isProxySocketData(value: unknown): value is ProxySocketData {
  return (
    isObject(value) &&
    value.kind === PROXY_SOCKET_KIND &&
    typeof value.target === "string" &&
    (value.target.startsWith("ws://") || value.target.startsWith("wss://"))
  )
}

function normalizeMessage(message: unknown): WebSocketMessage | null {
  if (typeof message === "string") {
    return message
  }

  if (message instanceof ArrayBuffer) {
    return message
  }

  if (ArrayBuffer.isView(message)) {
    const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
    return bytes.slice().buffer
  }

  return null
}

async function sendDownstream(ws: BunWebSocketLike, data: unknown): Promise<void> {
  const normalized =
    data instanceof Blob ? normalizeMessage(await data.arrayBuffer()) : normalizeMessage(data)

  if (normalized) {
    ws.send(normalized)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
