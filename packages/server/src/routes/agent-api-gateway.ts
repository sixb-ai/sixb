import type { SixbHostView } from "@sixb/core"
import { assertAgentExecutionRecord } from "@sixb/core/internal/agent-execution"
import {
  AGENT_API_GATEWAY_PREFIX,
  AGENT_API_ROUTES,
  type AgentExecutionAuthorization,
  isAllowedAgentApiRequest,
  isValidAgentApiGatewayCapability,
  MAIN_AGENT_ID,
  resolveAgentExecutionAuthorization,
  resolveInheritedAgentExecutionAuthorization,
} from "@sixb/core/internal/agents"
import { normalizeRoutePath, pathSegmentsFor } from "@sixb/core/internal/http"
import type { RequestExecutionAuthorization } from "@sixb/core/internal/request-execution"
import type {
  AgentRunRecord,
  AuthStorage,
  ConversationAgentRunRecord,
  ExecutionRecord,
  WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { type InternalRequestAuthState, registerInternalRequestAuthState } from "../auth/scope"
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
    authState.agentExecution.kind !== "conversation" &&
    input.request.method === "POST" &&
    matchesWorkflowRunStart(upstreamPath)
  ) {
    return jsonError(
      409,
      authState.agentExecution.kind === "workflow"
        ? "Workflow agent nodes cannot start another workflow run."
        : "Child agents cannot start a workflow run."
    )
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

  const storedAgentRun = await agentStorage?.runs.getById({
    projectId: host.id,
    id: input.runId,
  })
  const workflowRun = storedAgentRun
    ? null
    : await workflowRuns?.agentNodes.getByNodeRunId({
        projectId: host.id,
        nodeRunId: input.runId,
      })
  const runState = toGatewayRunState(storedAgentRun ?? null, workflowRun ?? null)
  if (
    !runState ||
    runState.run.status !== "running" ||
    !runState.run.execution ||
    runState.run.execution.queueLeaseExpiresAt.getTime() <= Date.now() ||
    !isValidAgentApiGatewayCapability({
      projectId: host.id,
      runId: input.runId,
      executionToken: runState.run.execution.token,
      capability: input.capability,
    })
  ) {
    return jsonError(403, "Agent API gateway capability is not valid for this run.")
  }

  if (!host.auth.isEnabled()) {
    return {
      authorization: { type: "disabled" as const },
      agentExecution: runState.agentExecution,
      ...(runState.agentRun === undefined ? {} : { agentRun: runState.agentRun }),
    }
  }

  const auth = host.storage.auth
  if (!auth) {
    return jsonError(501, "Agent API gateway is not configured for authenticated agent access.")
  }
  const execution = await host.storage.executions.getById({
    projectId: host.id,
    id: runState.run.executionId,
  })
  if (!execution) {
    return jsonError(403, "Agent run execution is not available.")
  }

  let authorization: RequestExecutionAuthorization
  try {
    authorization = await resolveGatewayRunAuthorization({ host, auth, runState, execution })
  } catch {
    return jsonError(403, "Agent run execution authority is not valid.")
  }

  return {
    authorization,
    agentExecution: runState.agentExecution,
    ...(runState.agentRun === undefined ? {} : { agentRun: runState.agentRun }),
  }
}

type GatewayRunState = {
  readonly run: AgentRunRecord | WorkflowAgentNodeRunRecord
  readonly runId: string
  readonly agentExecution: NonNullable<InternalRequestAuthState["agentExecution"]>
  readonly agentRun?: ConversationAgentRunRecord
} & (
  | { readonly authority: "inherited" }
  | { readonly authority: "managed"; readonly agentId: string }
)

function toGatewayRunState(
  storedRun: AgentRunRecord | null,
  workflowRun: WorkflowAgentNodeRunRecord | null
): GatewayRunState | null {
  if (storedRun?.kind === "subagent") {
    return {
      run: storedRun,
      runId: storedRun.id,
      agentExecution: {
        kind: "subagent",
        runId: storedRun.id,
        parentRunId: storedRun.parentRunId,
      },
      authority: "inherited",
    }
  }

  if (storedRun?.kind === "conversation") {
    const common = {
      run: storedRun,
      runId: storedRun.id,
      agentExecution: { kind: "conversation", runId: storedRun.id } as const,
      agentRun: storedRun,
    }
    if (storedRun.agentId === MAIN_AGENT_ID) {
      return { ...common, authority: "inherited" }
    }
    return { ...common, authority: "managed", agentId: storedRun.agentId }
  }

  if (!workflowRun) return null
  const common = {
    run: workflowRun,
    runId: workflowRun.nodeRunId,
    agentExecution: { kind: "workflow", nodeRunId: workflowRun.nodeRunId } as const,
  }
  if (workflowRun.agentId === MAIN_AGENT_ID) {
    return { ...common, authority: "inherited" }
  }
  return { ...common, authority: "managed", agentId: workflowRun.agentId }
}

async function resolveGatewayRunAuthorization(input: {
  readonly host: SixbHostView
  readonly auth: AuthStorage
  readonly runState: GatewayRunState
  readonly execution: ExecutionRecord
}): Promise<RequestExecutionAuthorization> {
  if (input.runState.authority === "inherited") {
    const resolved = await resolveInheritedAgentExecutionAuthorization({
      auth: input.auth,
      projectId: input.host.id,
      authorizationRef: input.execution.authorizationRef,
      security: input.host.definitions.security,
    })
    const authorization = inheritedRequestAuthorization(resolved, input.execution.authorizationRef)
    assertAgentExecutionRecord({
      execution: input.execution,
      runId: input.runState.runId,
      authorization,
    })
    return authorization
  }

  const resolved = await resolveAgentExecutionAuthorization({
    auth: input.auth,
    projectId: input.host.id,
    agentId: input.runState.agentId,
    authorizationRef: input.execution.authorizationRef,
    security: input.host.definitions.security,
  })
  const authorization = { type: "principal", context: resolved.context } as const
  assertAgentExecutionRecord({
    execution: input.execution,
    agentId: input.runState.agentId,
    runId: input.runState.runId,
    authorization,
  })
  return authorization
}

function inheritedRequestAuthorization(
  resolved: AgentExecutionAuthorization,
  authorizationRef: ExecutionRecord["authorizationRef"]
): RequestExecutionAuthorization {
  if (
    resolved.type !== "principal" ||
    authorizationRef.type !== "principal" ||
    authorizationRef.credential === undefined
  ) {
    return resolved
  }
  return {
    type: "principal",
    context: resolved.context,
    credential: authorizationRef.credential,
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
