import { timingSafeEqual } from "node:crypto"
import { type ForwardedSocket, forwardRequest, forwardWebSocket } from "@sixb/server"
import type { Server, ServerWebSocket } from "bun"
import type { DevChildMessage } from "./dev-messages"
import type { DevReporter } from "./dev-supervisor"
import { errorMessage } from "./errors"

/** The key a branch runtime asks every request for, set in its environment. */
export const BRANCH_KEY_ENV = "SIXB_BRANCH_KEY"

/** The header the project's server adds to every request it forwards to a branch. */
export const BRANCH_KEY_HEADER = "x-sixb-branch-key"

/** Where a branch's supervisor answers, whatever state the project is in. */
export const BRANCH_STATUS_PATH = "/__sixb/branch"

/** What a branch runtime serves right now: the generation the supervisor last started. */
export interface BranchRuntimeStatus {
  readonly branch: string
  /** Counts restarts: every source change that reaches the checkout starts a new generation. */
  readonly generation: number
  readonly state: "starting" | "ready" | "failed"
  /** The checkout's commit when the generation started. */
  readonly commit: string | null
  /** The generation's definitions manifest hash, once it serves. */
  readonly manifest: string | null
  readonly error: { readonly message: string; readonly file?: string } | null
}

interface SocketData {
  readonly path: string
  upstream?: ForwardedSocket
}

/**
 * The front of `sixb dev --branch`: it never imports project code, so it answers on the port
 * while the project restarts or fails to load. Every request must carry the branch's key, which
 * only the project's server holds. Status is its own; everything else goes to the API.
 */
export function startBranchFront(input: {
  readonly branch: string
  readonly key: string
  readonly host: string
  readonly port: number
  readonly apiPort: number
  readonly root: string
}): { readonly reporter: DevReporter; stop(): Promise<void> } {
  let status: BranchRuntimeStatus = {
    branch: input.branch,
    generation: 0,
    state: "starting",
    commit: null,
    manifest: null,
    error: null,
  }
  const key = Buffer.from(input.key)
  const authorized = (request: Request) => {
    const given = Buffer.from(request.headers.get(BRANCH_KEY_HEADER) ?? "")
    return given.length === key.length && timingSafeEqual(given, key)
  }
  const api = `127.0.0.1:${input.apiPort}`
  const statusResponse = (httpStatus = 200) =>
    Response.json(status, { status: httpStatus, headers: { "cache-control": "no-store" } })

  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: input.host,
    port: input.port,
    // Uploads go through the project's server first, which already caps them.
    maxRequestBodySize: 1024 * 1024 * 1024,
    async fetch(request, server) {
      if (!authorized(request)) return new Response("Unauthorized", { status: 401 })
      const url = new URL(request.url)
      if (url.pathname === BRANCH_STATUS_PATH) return statusResponse()
      if (status.state !== "ready") return statusResponse(503)

      const path = `${url.pathname}${url.search}`
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return server.upgrade(request, { data: { path } })
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 })
      }
      try {
        return await forwardRequest(request, `http://${api}${path}`, {
          requestHeaders: (name) => name !== BRANCH_KEY_HEADER,
        })
      } catch {
        // The generation stopped between the state check and the request.
        return statusResponse(503)
      }
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        ws.data.upstream = forwardWebSocket(ws, `ws://${api}${ws.data.path}`)
      },
      message(ws: ServerWebSocket<SocketData>, message) {
        ws.data.upstream?.send(message)
      },
      close(ws: ServerWebSocket<SocketData>, code, reason) {
        ws.data.upstream?.close(code, reason)
      },
    },
  })

  const update = (next: Partial<BranchRuntimeStatus>) => {
    status = { ...status, ...next }
  }
  const failed = (message: string, file?: string) =>
    update({ state: "failed", manifest: null, error: { message, ...(file ? { file } : {}) } })

  const reporter: DevReporter = {
    output: "inherit",
    line(text) {
      console.log(text)
    },
    message(message: DevChildMessage) {
      if (message.type === "ready") {
        update({ state: "ready", manifest: message.manifest ?? null, error: null })
        console.log(`[SixbDev] Branch ${input.branch} ready (generation ${status.generation}).`)
      } else if (message.type === "startup-error") {
        failed(message.error?.message ?? "The project failed to start.", message.error?.file)
      }
    },
    restarting(filename) {
      console.log(`[SixbDev] Source changed${filename ? `: ${filename}` : ""}. Restarting…`)
    },
    starting() {
      const generation = status.generation + 1
      update({ generation, state: "starting", commit: null, manifest: null, error: null })
      void readCommit(input.root).then((commit) => {
        if (status.generation === generation) update({ commit })
      })
    },
    exited(code) {
      if (status.state !== "failed") failed(`The project stopped (exit ${code}).`)
    },
    timedOut() {
      failed("The project took longer than a minute to start.")
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
