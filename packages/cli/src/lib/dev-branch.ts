import { timingSafeEqual } from "node:crypto"
import {
  BRANCH_HANDOVER_PREPARE_PATH,
  BRANCH_KEY_HEADER,
  BRANCH_STATUS_PATH,
  type BranchRuntimeStatus,
  HOSTED_BRANCH_COPY,
  isBranchApiPath,
} from "@sixb/core/internal/branches"
import {
  type ForwardedHandshake,
  type ForwardedSocket,
  forwardedHandshake,
  forwardRequest,
  forwardWebSocket,
} from "@sixb/core/internal/http"
import type { Server, ServerWebSocket } from "bun"
import { loadedCopyOf } from "./branch-from-production"
import { type DevChildMessage, loadingLine } from "./dev-messages"
import type { DevReporter } from "./dev-supervisor"
import { errorMessage } from "./errors"

interface SocketData {
  readonly path: string
  readonly target: string
  /** The browser's cookies and origin, which the API checks as it checks any request. */
  readonly handshake: ForwardedHandshake
  readonly signedIn: boolean
  upstream?: ForwardedSocket
}

/**
 * The front of a hosted branch's `sixb dev`: it never imports project code, so it answers on the
 * port while the project restarts or fails to load. Its status and the handover's preparation take
 * the branch's key, which only production holds; people reach the rest, signed in by the branch's
 * own sessions. Status is its own. The API's paths go to the API, everything else
 * to the project's app while it runs. What the API accepts from a signed-in browser counts as
 * someone using the branch: production stops a branch nobody uses, and a crawler, a refused
 * request or the "starting" page keeps none up.
 */
export function startBranchFront(input: {
  readonly branch: string
  readonly key: string
  readonly host: string
  readonly port: number
  readonly apiPort: number
  readonly appPort: number
  readonly root: string
}): { readonly reporter: DevReporter; readonly port: number; stop(): Promise<void> } {
  let status: BranchRuntimeStatus = {
    branch: input.branch,
    generation: 0,
    state: "starting",
    commit: null,
    error: null,
    requests: 0,
    copy: null,
  }
  const key = Buffer.from(input.key)
  const authorized = (request: Request) => {
    const given = Buffer.from(request.headers.get(BRANCH_KEY_HEADER) ?? "")
    return given.length === key.length && timingSafeEqual(given, key)
  }
  const api = `127.0.0.1:${input.apiPort}`
  const app = `127.0.0.1:${input.appPort}`
  // The app's dev server, once the generation reports one: a project may have no app.
  let serving = false
  const upstream = (pathname: string) => (serving && !isBranchApiPath(pathname) ? app : api)
  const statusResponse = (httpStatus = 200) =>
    Response.json(status, { status: httpStatus, headers: { "cache-control": "no-store" } })
  // What a person sees while the branch restarts: nothing of its errors, which are production's.
  const startingResponse = () =>
    new Response("The branch is starting. Reload in a moment.", {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "2" },
    })

  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: input.host,
    port: input.port,
    // Uploads go through the project's server first, which already caps them.
    maxRequestBodySize: 1024 * 1024 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url)
      // Production's own paths take the key; people reach the rest, which the branch's own
      // sessions guard: production signs them in through the handover.
      const production =
        url.pathname === BRANCH_STATUS_PATH || url.pathname === BRANCH_HANDOVER_PREPARE_PATH
      if (production && !authorized(request)) return new Response("Unauthorized", { status: 401 })
      if (url.pathname === BRANCH_STATUS_PATH) return statusResponse()

      if (status.state !== "ready") {
        return production ? statusResponse(503) : startingResponse()
      }

      const path = `${url.pathname}${url.search}`
      const target = upstream(url.pathname)
      const signedIn = request.headers.has("cookie") || request.headers.has("authorization")
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const handshake = forwardedHandshake(request, (name) => name !== BRANCH_KEY_HEADER)
        if (!server.upgrade(request, { data: { path, target, handshake, signedIn } })) {
          return new Response("WebSocket upgrade failed", { status: 400 })
        }
        return undefined
      }
      try {
        const response = await forwardRequest(request, `http://${target}${path}`, {
          // The key goes on only where the branch checks it again: the handover.
          requestHeaders: (name) => production || name !== BRANCH_KEY_HEADER,
        })
        const accepted = response.status !== 401 && response.status !== 403
        if (!production && signedIn && accepted && isBranchApiPath(url.pathname)) used()
        return response
      } catch {
        // The generation stopped between the state check and the request.
        return production ? statusResponse(503) : startingResponse()
      }
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        // A socket is use once the branch accepts it: a stale tab's refused reconnects keep
        // nothing up.
        ws.data.upstream = forwardWebSocket(
          ws,
          `ws://${ws.data.target}${ws.data.path}`,
          ws.data.handshake,
          () => {
            if (ws.data.signedIn) used()
          }
        )
      },
      message(ws: ServerWebSocket<SocketData>, message) {
        ws.data.upstream?.send(message)
      },
      close(ws: ServerWebSocket<SocketData>, code, reason) {
        ws.data.upstream?.close(code, reason)
      },
    },
  })

  const used = () => {
    status = { ...status, requests: status.requests + 1 }
  }
  const update = (next: Partial<BranchRuntimeStatus>) => {
    status = { ...status, ...next }
  }
  const failed = (message: string, file?: string) =>
    update({ state: "failed", error: { message, ...(file ? { file } : {}) } })

  const reporter: DevReporter = {
    output: "inherit",
    line(text) {
      console.log(text)
    },
    message(message: DevChildMessage) {
      if (message.type === "ready") {
        serving = message.app !== null
        const generation = status.generation
        update({ state: "ready", error: null })
        console.log(`[SixbDev] Branch ${input.branch} ready (generation ${generation}).`)

        // Then what copy it runs on: the one this generation loaded, or kept.
        void loadedCopyOf(input.root, HOSTED_BRANCH_COPY).then((copy) => {
          if (status.generation === generation) update({ copy })
        })
      } else if (message.type === "loading") {
        console.log(`[SixbDev] ${loadingLine(message)}`)
      } else if (message.type === "startup-error") {
        failed(message.error?.message ?? "The project failed to start.", message.error?.file)
      }
    },
    restarting(filename) {
      console.log(`[SixbDev] Source changed${filename ? `: ${filename}` : ""}. Restarting…`)
    },
    starting() {
      const generation = status.generation + 1
      update({ generation, state: "starting", commit: null, error: null })
      void readCommit(input.root).then((commit) => {
        if (status.generation === generation) update({ commit })
      })
    },
    exited(code) {
      if (status.state !== "failed") failed(`The project stopped (exit ${code}).`)
    },
    timedOut(timeout) {
      // A copy that stopped loading says so; any other start had its minute.
      failed(
        timeout.kind === "load-stalled"
          ? timeout.message
          : "The project took longer than a minute to start."
      )
    },
    error(text) {
      console.error(`[SixbDev] ${text}`)
    },
    stopping() {},
    async stop() {
      await server.stop(true)
    },
  }
  return {
    reporter,
    port: server.port ?? input.port,
    stop: () => server.stop(true),
  }
}

async function readCommit(root: string): Promise<string | null> {
  try {
    const git = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    })
    const [output, code] = await Promise.all([new Response(git.stdout).text(), git.exited])
    return code === 0 ? output.trim() : null
  } catch (error) {
    console.error(`[SixbDev] Could not read the checkout's commit: ${errorMessage(error)}`)
    return null
  }
}
