import type { SixbHostView } from "@sixb/core"
import { assertAgentExecutionRecord } from "@sixb/core/internal/agent-execution"
import {
  AGENT_API_GATEWAY_PREFIX,
  AGENT_API_ROUTES,
  type AgentExecutionAuthorization,
  isAllowedAgentApiRequest,
  isValidAgentApiGatewayCapability,
  resolveAgentExecutionAuthorization,
  resolveInheritedAgentExecutionAuthorization,
} from "@sixb/core/internal/agents"
import { normalizeRoutePath, pathSegmentsFor } from "@sixb/core/internal/http"
import type {
  AgentRunRecord,
  AuthStorage,
  ConversationAgentRunRecord,
  ExecutionRecord,
  WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { type InternalRequestAuthState, registerInternalRequestAuthState } from "../auth/scope"
import { RequestBodyTooLargeError, readRequestBodyWithLimit } from "../utils/request-body"
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
  // A workflow step is a fixed assignment: what it does must not change because a conversation
  // saved a note.
  if (authState.agentExecution.kind === "workflow" && matchesAgentMemory(upstreamPath)) {
    return jsonError(403, "Workflow agent nodes have no Agent memory.")
  }

  // A turn runs with its sender's rights, but everyone in a shared conversation sees what it
  // reads: the worker installs the project's memory alone, and the sender's cannot be pulled or
  // saved either. Any repo name but `project` is refused, an encoded `user` included.
  if (
    matchesAgentMemory(upstreamPath) &&
    pathSegmentsFor(upstreamPath)[2] !== "project" &&
    (await answersInSharedThread(input.host, authState.agentExecution))
  ) {
    return jsonError(
      403,
      "This conversation is shared with other people, so only the project's memory is available in it."
    )
  }

  let body: Uint8Array<ArrayBuffer> | undefined
  try {
    body = await readGatewayRequestBody(input.request, upstreamPath)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonError(413, error.message)
    }
    throw error
  }
  const internalUrl = new URL(`${upstreamPath}${sourceUrl.search}`, input.request.url)
  // The caller's signal travels with the request: a sandbox client that gives up cancels the
  // forwarded work, model calls included.
  const internalRequest = new Request(internalUrl, {
    method: input.request.method,
    headers: forwardedRequestHeaders(input.request.headers),
    body,
    signal: input.request.signal,
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

  const execution = await host.storage.executions.getById({
    projectId: host.id,
    id: runState.run.executionId,
  })
  if (!execution) {
    return jsonError(403, "Agent run execution is not available.")
  }

  // Authority comes from the record whether auth is enabled or not: an auth-disabled record is
  // unrestricted, and a workflow AI task has its groups, as for its in-process tools. Only a record
  // naming a principal needs auth storage.
  const auth = host.storage.auth
  if (!auth && execution.authorizationRef.type !== "disabled") {
    return jsonError(501, "Agent API gateway is not configured for authenticated agent access.")
  }

  let authorization: AgentExecutionAuthorization
  try {
    authorization = await resolveGatewayRunAuthorization({ host, auth, runState, execution })
  } catch {
    return jsonError(403, "Agent run execution authority is not valid.")
  }

  // The request runs inside the run's own execution, restored from server-side records only
  // (run, then its execution record): what it starts is a child of the run and keeps the run's
  // requester and correlation, whatever the request's headers say. Authority is the record's
  // current grants, resolved on every request when it is admitted; a request admitted before the
  // run ends finishes under it, like an in-process tool call. An agent execution also gets
  // provider access (blobs, models, connectors), and so does any route added to the allowlist.
  return {
    runExecution: {
      execution,
      ...(runState.authority === "managed" ? { actorId: runState.actorId } : {}),
      runId: runState.runId,
      attempt: runState.run.attempt,
      authorization,
    },
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
  | { readonly authority: "managed"; readonly actorId: string }
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
    return { ...common, authority: "inherited" }
  }

  if (!workflowRun) return null
  const common = {
    run: workflowRun,
    runId: workflowRun.nodeRunId,
    agentExecution: { kind: "workflow", nodeRunId: workflowRun.nodeRunId } as const,
  }
  return { ...common, authority: "managed", actorId: workflowRun.actorId }
}

async function resolveGatewayRunAuthorization(input: {
  readonly host: SixbHostView
  readonly auth: AuthStorage | undefined
  readonly runState: GatewayRunState
  readonly execution: ExecutionRecord
}): Promise<AgentExecutionAuthorization> {
  if (input.runState.authority === "inherited") {
    const authorization = await resolveInheritedAgentExecutionAuthorization({
      auth: input.auth,
      projectId: input.host.id,
      authorizationRef: input.execution.authorizationRef,
      security: input.host.definitions.security,
    })
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
    actorId: input.runState.actorId,
    authorizationRef: input.execution.authorizationRef,
    security: input.host.definitions.security,
  })
  const authorization = { type: "principal", context: resolved.context } as const
  assertAgentExecutionRecord({
    execution: input.execution,
    actorId: input.runState.actorId,
    runId: input.runState.runId,
    authorization,
  })
  return authorization
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

async function readGatewayRequestBody(
  request: Request,
  upstreamPath: string
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body || request.method === "GET" || request.method === "HEAD") {
    return undefined
  }

  if (isSimpleFileUpload(request.method, upstreamPath)) {
    return readRequestBodyWithLimit(
      request,
      DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES,
      `Agent API gateway file upload request body exceeds the ${DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES} byte limit.`
    )
  }
  return readRequestBodyWithLimit(
    request,
    MAX_AGENT_API_BODY_BYTES,
    "Agent API gateway request body exceeds 1MB."
  )
}

function isSimpleFileUpload(method: string, pathname: string): boolean {
  return method === "POST" && normalizeRoutePath(pathname) === "/api/files"
}

/** Whether the run, or the conversation run that started it, answers in a shared thread. */
async function answersInSharedThread(
  host: SixbHostView,
  agentExecution: GatewayRunState["agentExecution"]
): Promise<boolean> {
  const agents = host.storage.agents
  if (!agents || agentExecution.kind === "workflow") return false

  const conversationRunId =
    agentExecution.kind === "subagent" ? agentExecution.parentRunId : agentExecution.runId
  const run = await agents.runs.getById({ projectId: host.id, id: conversationRunId })
  if (run?.kind !== "conversation") return false

  const participants = await agents.threads.listParticipants({
    projectId: host.id,
    threadIds: [run.threadId],
  })
  return participants.length > 0
}

function matchesAgentMemory(pathname: string): boolean {
  const segments = pathSegmentsFor(pathname)
  return segments[0] === "api" && segments[1] === "agent-memory"
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

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}
