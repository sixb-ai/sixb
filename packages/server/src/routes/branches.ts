import type { SixbHostView } from "@sixb/core"
import {
  BRANCH_KEY_HEADER,
  BranchRequestError,
  type BranchView,
  getProjectBranches,
} from "@sixb/core/internal/branches"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { type ForwardedSocket, forwardRequest, forwardWebSocket } from "../forward"
import { OPENAPI_TAGS } from "../openapi/tags"
import { BranchListSchema, BranchSchema, OpenBranchBodySchema } from "../schemas/branches"
import { ErrorResponseSchema } from "../schemas/common"
import { handleRouteError, type RouteResponseSet } from "../utils/http"
import { wsRequestSixb } from "../utils/ws"

/** Where a branch's runtime is reached through the project's server: same origin, same session. */
export const BRANCH_FORWARD_PREFIX = "/branches"

const ERRORS = { 400: ErrorResponseSchema, 403: ErrorResponseSchema, 409: ErrorResponseSchema }

export function registerBranchRoutes(app: Elysia, _host: SixbHostView) {
  app.get(
    "/api/branches",
    async (context) => {
      try {
        const branches = await getProjectBranches(requireRequestSixb(context)).list()
        return { branches: branches.map(serializeBranch) }
      } catch (error) {
        return branchError(error, context.set)
      }
    },
    {
      response: { 200: BranchListSchema, ...ERRORS },
      detail: {
        summary: "List the project's branches",
        description: "Every branch with a runtime of its own, and where that runtime is.",
        tags: [OPENAPI_TAGS.project.name],
        operationId: "listBranches",
        security: accessTokenSecurityRequirement("listBranches"),
      },
    }
  )

  app.post(
    "/api/branches",
    async (context) => {
      try {
        const branches = getProjectBranches(requireRequestSixb(context))
        return serializeBranch(await branches.open(context.body.name))
      } catch (error) {
        return branchError(error, context.set)
      }
    },
    {
      body: OpenBranchBodySchema,
      response: { 200: BranchSchema, ...ERRORS },
      detail: {
        summary: "Open a branch",
        description:
          "Wants the branch's runtime running, adding the branch when it's new. A worker starts it in a sandbox of its own, checked out on the branch; it stops after twenty minutes without a visit.",
        tags: [OPENAPI_TAGS.project.name],
        operationId: "openBranch",
        security: accessTokenSecurityRequirement("openBranch"),
      },
    }
  )

  app.get(
    "/api/branches/:name",
    async (context) => {
      try {
        const branch = await getProjectBranches(requireRequestSixb(context)).get(
          context.params.name
        )
        if (!branch) {
          context.set.status = 404
          return { error: `[Sixb] There is no branch '${context.params.name}'.` }
        }
        return serializeBranch(branch)
      } catch (error) {
        return branchError(error, context.set)
      }
    },
    {
      response: { 200: BranchSchema, 404: ErrorResponseSchema, ...ERRORS },
      detail: {
        summary: "Get a branch",
        description: "A branch name with `/` in it is sent encoded, as `feature%2Finvoices`.",
        tags: [OPENAPI_TAGS.project.name],
        operationId: "getBranch",
        security: accessTokenSecurityRequirement("getBranch"),
      },
    }
  )

  app.post(
    "/api/branches/:name/stop",
    async (context) => {
      try {
        const branches = getProjectBranches(requireRequestSixb(context))
        return serializeBranch(await branches.stop(context.params.name))
      } catch (error) {
        return branchError(error, context.set)
      }
    },
    {
      response: { 200: BranchSchema, 404: ErrorResponseSchema, ...ERRORS },
      detail: {
        summary: "Stop a branch",
        description: "Stops its runtime. Its sandbox keeps what it held for the next open.",
        tags: [OPENAPI_TAGS.project.name],
        operationId: "stopBranch",
        security: accessTokenSecurityRequirement("stopBranch"),
      },
    }
  )

  registerBranchForwarding(app)
  return app
}

/**
 * `/branches/:name/*` reaches what the branch's runtime serves at `/*`, for whoever may manage the
 * project's source. The request leaves its credentials here: the runtime gets the branch's key
 * instead, and nothing it answers can set this origin's cookies.
 */
function registerBranchForwarding(app: Elysia) {
  const target = async (sixb: Parameters<typeof getProjectBranches>[0], name: string) =>
    getProjectBranches(sixb).route(name)

  app.ws(`${BRANCH_FORWARD_PREFIX}/:name/ws/*`, {
    async beforeHandle(context) {
      try {
        const route = await target(requireRequestSixb(context), context.params.name)
        if (!route?.url || route.state !== "ready") {
          context.set.status = 503
          return { error: "[Sixb] The branch isn't serving." }
        }
        sockets.set(context.request, { url: route.url, key: route.key })
      } catch (error) {
        return branchError(error, context.set)
      }
    },
    open(ws) {
      const data = ws.data as unknown as { request: Request; params: { name: string } }
      const route = sockets.get(data.request)
      if (!route || !wsRequestSixb(ws)) {
        ws.close(1011, "Branch unavailable")
        return
      }
      const path = upstreamPath(data.request.url, data.params.name)
      const url = new URL(path, route.url)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      upstreams.set(
        ws.raw,
        forwardWebSocket(ws, url.href, { headers: { [BRANCH_KEY_HEADER]: route.key } })
      )
    },
    message(ws, message) {
      upstreams
        .get(ws.raw)
        ?.send(
          typeof message === "string" || message instanceof Uint8Array
            ? message
            : JSON.stringify(message)
        )
    },
    close(ws, code, reason) {
      upstreams.get(ws.raw)?.close(code, reason)
      upstreams.delete(ws.raw)
    },
  })

  app.all(
    `${BRANCH_FORWARD_PREFIX}/:name/*`,
    async (context) => {
      try {
        const route = await target(requireRequestSixb(context), context.params.name)
        if (!route) {
          context.set.status = 404
          return { error: `[Sixb] There is no branch '${context.params.name}'.` }
        }
        if (!route.url || route.state === "stopped") {
          context.set.status = 503
          return { error: "[Sixb] The branch isn't running. Open it to start its runtime." }
        }
        const path = upstreamPath(context.request.url, context.params.name)
        return await forwardRequest(context.request, new URL(path, route.url).href, {
          requestHeaders: (name) => FORWARDED_REQUEST_HEADERS.has(name),
          responseHeaders: (name) => name !== "set-cookie",
          headers: { [BRANCH_KEY_HEADER]: route.key },
        })
      } catch (error) {
        return branchError(error, context.set)
      }
    },
    { parse: "none", detail: { hide: true } }
  )
}

const sockets = new WeakMap<Request, { readonly url: string; readonly key: string }>()
const upstreams = new WeakMap<object, ForwardedSocket>()

/** What a request may carry on to a branch: its content, never its credentials. */
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-length",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "range",
  "user-agent",
])

/** The path and query the runtime serves for a forwarded one, its prefix taken off. */
function upstreamPath(requestUrl: string, name: string): string {
  const url = new URL(requestUrl)
  const prefix = `${BRANCH_FORWARD_PREFIX}/${encodeURIComponent(name)}`
  const raw = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length)
    : url.pathname.slice(url.pathname.indexOf("/", BRANCH_FORWARD_PREFIX.length + 1))
  return `${raw || "/"}${url.search}`
}

function serializeBranch(branch: BranchView) {
  return {
    ...branch,
    createdAt: branch.createdAt.toISOString(),
    updatedAt: branch.updatedAt.toISOString(),
    lastSeenAt: branch.lastSeenAt.toISOString(),
  }
}

function branchError(error: unknown, set: RouteResponseSet) {
  if (error instanceof BranchRequestError) {
    set.status =
      error.code === "invalid_branch" ? 400 : error.code === "branch_not_found" ? 404 : 409
    return { error: error.message }
  }
  return handleRouteError(error, set)
}
