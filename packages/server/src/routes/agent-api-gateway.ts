import type { AuthorizationContext, SixbHostView } from "@sixb/core"
import { assertAgentExecutionRecord } from "@sixb/core/internal/agent-execution"
import {
  AGENT_API_GATEWAY_PREFIX,
  AGENT_API_ROUTES,
  isAllowedAgentApiRequest,
  isValidAgentApiGatewayCapability,
  resolveAgentRunAuthorization,
} from "@sixb/core/internal/agents"
import { normalizeRoutePath, pathSegmentsFor } from "@sixb/core/internal/http"
import type { Elysia } from "elysia"
import { registerInternalRequestAuthState } from "../auth/scope"
import { DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES } from "./files"

const MAX_AGENT_API_BODY_BYTES = 1_000_000
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export function registerAgentApiGatewayRoutes(app: Elysia, host: SixbHostView) {
  for (const route of AGENT_API_ROUTES) {
    const path = `${AGENT_API_GATEWAY_PREFIX}/:agentGatewayRunId/:agentGatewayCapability${route.path}`
    const handler = async (context: AgentApiGatewayRouteContext) =>
      handleAgentApiGatewayRequest({
        host,
        app,
        request: context.request,
        agentRunId: context.params.agentGatewayRunId ?? "",
        capability: context.params.agentGatewayCapability ?? "",
      })

    if (route.method === "GET") {
      app.get(path, handler, { detail: { hide: true } })
      continue
    }
    if (route.method === "POST") {
      app.post(path, handler, { detail: { hide: true } })
      continue
    }

    throw new Error(`[SixbServer] Unsupported agent API gateway method '${route.method}'.`)
  }
}

interface AgentApiGatewayRouteContext {
  readonly request: Request
  readonly params: Readonly<Record<string, string | undefined>>
}

async function handleAgentApiGatewayRequest(input: {
  readonly host: SixbHostView
  readonly app: Elysia
  readonly request: Request
  readonly agentRunId: string
  readonly capability: string
}): Promise<Response> {
  const sourceUrl = new URL(input.request.url)
  const upstreamPath = gatewayUpstreamPath(sourceUrl.pathname)
  if (!isAllowedAgentApiRequest(input.request.method, upstreamPath)) {
    return jsonError(
      403,
      `Agent API gateway does not allow ${input.request.method} ${upstreamPath}.`
    )
  }

  const authState = await resolveAgentRunAuthState(input.host, {
    runId: input.agentRunId,
    capability: input.capability,
  })
  if (authState instanceof Response) {
    return authState
  }
  if (
    authState.agentExecution.kind === "workflow" &&
    input.request.method === "POST" &&
    matchesWorkflowRunStart(upstreamPath)
  ) {
    return jsonError(409, "Workflow agent nodes cannot start another workflow run.")
  }

  let body: ArrayBuffer | undefined
  try {
    body = await readRequestBody(
      input.request,
      isSimpleFileUpload(input.request.method, upstreamPath)
        ? DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES
        : MAX_AGENT_API_BODY_BYTES
    )
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonError(413, error.message)
    }
    throw error
  }
  const internalUrl = new URL(`${upstreamPath}${sourceUrl.search}`, input.request.url)
  const internalRequest = new Request(internalUrl, {
    method: input.request.method,
    headers: forwardedRequestHeaders(input.request.headers),
    body,
  })

  registerInternalRequestAuthState(internalRequest, authState)

  const response = await input.app.fetch(internalRequest)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: forwardedResponseHeaders(response.headers),
  })
}

async function resolveAgentRunAuthState(
  host: SixbHostView,
  input: { readonly runId: string; readonly capability: string }
) {
  const agentStorage = host.storage.agents
  const workflowRuns = host.storage.workflowRuns
  if (!agentStorage && !workflowRuns) {
    // 501, not 403: nothing about the caller is being refused — neither storage role
    // that could hold an agent run is configured, so no request can ever succeed here.
    return jsonError(501, "Agent API gateway is not configured for this runtime.")
  }

  const conversationalRun = await agentStorage?.runs.getById({
    projectId: host.id,
    id: input.runId,
  })
  const workflowRun = conversationalRun
    ? null
    : await workflowRuns?.agentNodes.getByNodeRunId({
        projectId: host.id,
        nodeRunId: input.runId,
      })
  const run = conversationalRun ?? workflowRun
  const agentExecution = conversationalRun
    ? ({ kind: "conversation", runId: conversationalRun.id } as const)
    : workflowRun
      ? ({ kind: "workflow", nodeRunId: workflowRun.nodeRunId } as const)
      : null
  if (
    !run ||
    !agentExecution ||
    run.status !== "running" ||
    !run.execution ||
    run.execution.queueLeaseExpiresAt.getTime() <= Date.now() ||
    !isValidAgentApiGatewayCapability({
      projectId: host.id,
      runId: input.runId,
      executionToken: run.execution.token,
      capability: input.capability,
    })
  ) {
    return jsonError(403, "Agent API gateway capability is not valid for this run.")
  }

  const auth = host.storage.auth
  if (!auth) {
    return jsonError(501, "Agent API gateway is not configured for authenticated agent access.")
  }
  const execution = await host.storage.executions.getById({
    projectId: host.id,
    id: run.executionId,
  })
  if (!execution) {
    return jsonError(403, "Agent run execution is not available.")
  }

  let authz: AuthorizationContext
  try {
    const resolved = await resolveAgentRunAuthorization({
      auth,
      projectId: host.id,
      agentId: run.agentId,
      execution,
      // A workflow agent node always acts under the agent's own service account, so it carries no
      // requester snapshot and never reaches the delegated branch.
      run: {
        requesterAuthorizationGroupIds: conversationalRun?.requesterAuthorizationGroupIds ?? [],
      },
      security: host.definitions.security,
    })
    assertAgentExecutionRecord({
      execution,
      agentId: run.agentId,
      runId: input.runId,
      authorization: resolved.context,
    })
    authz = resolved.context
  } catch {
    return jsonError(403, "Agent run execution authority is not valid.")
  }

  return {
    authorization: { type: "principal" as const, context: authz },
    agentExecution,
    ...(conversationalRun ? { agentRun: conversationalRun } : {}),
  }
}

function gatewayUpstreamPath(pathname: string): string {
  const prefixLength = pathSegmentsFor(AGENT_API_GATEWAY_PREFIX).length
  const segments = pathSegmentsFor(pathname)
  const upstreamSegments = segments.slice(prefixLength + 2)
  return normalizeRoutePath(`/${upstreamSegments.join("/")}`)
}

function forwardedRequestHeaders(source: Headers): Headers {
  const headers = new Headers()
  copyHeader(source, headers, "accept")
  copyHeader(source, headers, "content-type")
  return headers
}

function forwardedResponseHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const [key, value] of source) {
    const normalized = key.toLowerCase()
    if (
      HOP_BY_HOP_RESPONSE_HEADERS.has(normalized) ||
      normalized === "content-length" ||
      normalized === "set-cookie"
    ) {
      continue
    }
    headers.append(key, value)
  }
  return headers
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name)
  if (value !== null) {
    target.set(name, value)
  }
}

async function readRequestBody(
  request: Request,
  maxBytes: number
): Promise<ArrayBuffer | undefined> {
  if (!request.body || request.method === "GET" || request.method === "HEAD") {
    return undefined
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      throw new PayloadTooLargeError(
        maxBytes === MAX_AGENT_API_BODY_BYTES
          ? "Agent API gateway request body exceeds 1MB."
          : `Agent API gateway file upload request body exceeds the ${maxBytes} byte limit.`
      )
    }
    chunks.push(value)
  }

  return concatChunks(chunks, total)
}

function isSimpleFileUpload(method: string, pathname: string): boolean {
  return method === "POST" && normalizeRoutePath(pathname) === "/api/files"
}

function matchesWorkflowRunStart(pathname: string): boolean {
  const segments = pathSegmentsFor(pathname)
  return (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "workflows" &&
    segments[3] === "runs"
  )
}

function concatChunks(chunks: readonly Uint8Array[], total: number): ArrayBuffer {
  const buffer = new ArrayBuffer(total)
  const result = new Uint8Array(buffer)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return buffer
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

class PayloadTooLargeError extends Error {}
