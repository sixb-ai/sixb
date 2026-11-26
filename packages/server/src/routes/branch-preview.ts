import type { SixbHostView } from "@sixb/core"
import { BRANCH_KEY_HEADER, previewNamespaceOf } from "@sixb/core/internal/branches"
import {
  type ForwardedHandshake,
  type ForwardedSocket,
  forwardedHandshake,
  forwardRequest,
  forwardWebSocket,
} from "@sixb/core/internal/http"
import type { BranchRecord } from "@sixb/core/storage"
import type { Server, ServerWebSocket } from "bun"

/** How long a branch's row is trusted for its preview host: a stopped branch stops answering within it. */
const LOOKUP_TTL_MS = 2_000
/** Requests and sockets production forwards to branches at once, all branches together. */
export const BRANCH_PREVIEW_MAX_IN_FLIGHT = 64
/** How long a branch has to start answering a request. */
export const BRANCH_PREVIEW_HEADERS_TIMEOUT_MS = 30_000
/** The longest a forwarded response streams, an event stream included. */
export const BRANCH_PREVIEW_RESPONSE_MAX_MS = 5 * 60_000
/** The longest a forwarded WebSocket stays open. */
export const BRANCH_PREVIEW_SOCKET_MAX_MS = 60 * 60_000

/** A WebSocket production holds open for a branch's page, forwarded to the branch. */
export class PreviewSocket {
  upstream?: ForwardedSocket
  timer?: ReturnType<typeof setTimeout>

  constructor(
    readonly target: string,
    /** The browser's cookies and origin, without production's key: the branch's to check. */
    readonly handshake: ForwardedHandshake,
    readonly release: () => void
  ) {}
}

/**
 * Production's side of a branch's preview host (`<namespace>.<preview domain>`): everything sent
 * to it is the branch's, never production's, so it goes to the branch's runtime whole, without
 * production's key. Branch code answers it, so it is bounded: a request has 30 s to start
 * answering and 5 min to finish, a socket an hour, and branches share 64 of them at once.
 */
export class BranchPreview {
  private readonly lookups = new Map<
    string,
    { readonly at: number; readonly branch: Promise<BranchRecord | null> }
  >()
  private inFlight = 0

  constructor(private readonly host: SixbHostView) {}

  /** The branch's answer, undefined once upgraded to a socket, or null for production's own host. */
  fetch(
    request: Request,
    server: Server<unknown>
  ): Response | Promise<Response | undefined> | null {
    const previewDomain = this.host.source?.previewDomain ?? null
    const namespace = previewNamespaceOf(request.headers.get("host"), previewDomain)
    if (namespace === null) return null
    if (namespace === "other") return noBranch()

    return this.forward(request, server, namespace)
  }

  readonly websocket = {
    open: (ws: ServerWebSocket<PreviewSocket>) => {
      const socket = ws.data
      socket.upstream = forwardWebSocket(ws, socket.target, socket.handshake)
      socket.timer = setTimeout(
        () => ws.close(1001, "Open the branch again"),
        BRANCH_PREVIEW_SOCKET_MAX_MS
      )
    },
    message: (ws: ServerWebSocket<PreviewSocket>, message: string | Buffer) => {
      ws.data.upstream?.send(message)
    },
    close: (ws: ServerWebSocket<PreviewSocket>, code: number, reason: string) => {
      clearTimeout(ws.data.timer)
      ws.data.upstream?.close(code, reason)
      ws.data.release()
    },
  }

  private async forward(
    request: Request,
    server: Server<unknown>,
    namespace: string
  ): Promise<Response | undefined> {
    const branch = await this.lookup(namespace)
    if (!branch || branch.wanted === "deleted") return noBranch()
    if (branch.state !== "ready" || !branch.url) return starting()

    const release = this.acquire()
    if (!release) return busy()

    const url = new URL(request.url)
    const target = `${branch.url.replace(/\/+$/, "")}${url.pathname}${url.search}`

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const socket = new PreviewSocket(
        target.replace(/^http/, "ws"),
        forwardedHandshake(request, (name) => name !== BRANCH_KEY_HEADER),
        release
      )
      if (server.upgrade(request, { data: socket })) return undefined
      release()
      return new Response("WebSocket upgrade failed", { status: 400 })
    }

    const deadline = new AbortController()
    const abort = () => deadline.abort()
    request.signal.addEventListener("abort", abort, { once: true })
    let timer = setTimeout(abort, BRANCH_PREVIEW_HEADERS_TIMEOUT_MS)
    const done = () => {
      clearTimeout(timer)
      request.signal.removeEventListener("abort", abort)
      release()
    }

    try {
      const response = await forwardRequest(request, target, {
        // Only production holds the key: a request that names it is not production's.
        requestHeaders: (name) => name !== BRANCH_KEY_HEADER,
        signal: deadline.signal,
      })
      clearTimeout(timer)
      timer = setTimeout(abort, BRANCH_PREVIEW_RESPONSE_MAX_MS)
      return releasedWhenRead(response, done)
    } catch {
      const timedOut = deadline.signal.aborted && !request.signal.aborted
      done()
      return new Response(
        timedOut ? "The branch took too long to answer." : "The branch did not answer.",
        { status: timedOut ? 504 : 502 }
      )
    }
  }

  /** The branch a namespace names, read again once its row is 2 s old. */
  private lookup(namespace: string): Promise<BranchRecord | null> {
    const now = Date.now()
    const cached = this.lookups.get(namespace)
    if (cached && now - cached.at < LOOKUP_TTL_MS) return cached.branch

    const storage = this.host.storage.hostedBranches
    const branch = storage
      ? storage.getByNamespace({ projectId: this.host.id, namespace }).catch(() => null)
      : Promise.resolve(null)
    this.lookups.set(namespace, { at: now, branch })
    if (this.lookups.size > 1_000) this.lookups.delete(this.lookups.keys().next().value as string)
    return branch
  }

  /** A slot for one request or socket, or null when branches hold them all. */
  private acquire(): (() => void) | null {
    if (this.inFlight >= BRANCH_PREVIEW_MAX_IN_FLIGHT) return null
    this.inFlight += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight -= 1
    }
  }
}

/** The response as it streams, calling `done` once its body ends, fails or is cancelled. */
function releasedWhenRead(response: Response, done: () => void): Response {
  if (!response.body) {
    done()
    return response
  }

  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: ended, value } = await reader.read()
        if (ended) {
          done()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        done()
        controller.error(error)
      }
    },
    cancel(reason) {
      done()
      return reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function noBranch(): Response {
  return new Response("No branch runs here.", { status: 404 })
}

function starting(): Response {
  return new Response("The branch is starting. Reload in a moment.", {
    status: 503,
    headers: { "cache-control": "no-store", "retry-after": "5" },
  })
}

function busy(): Response {
  return new Response("Branches are busy. Try again in a moment.", {
    status: 503,
    headers: { "retry-after": "5" },
  })
}
