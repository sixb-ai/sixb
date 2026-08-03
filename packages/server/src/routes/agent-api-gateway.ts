import { type OntologySource, resolveAuthorizationContext, type Sixb } from "@sixb/core"
import { isSixbError, SixbError } from "@sixb/core/errors"
import {
  AGENT_API_GATEWAY_PREFIX,
  AGENT_API_ROUTES,
  isAllowedAgentApiRequest,
  isValidAgentApiGatewayCapability,
} from "@sixb/core/internal/agents"
import { normalizeRoutePath, pathSegmentsFor } from "@sixb/core/internal/http"
import type { Elysia } from "elysia"
import { registerInternalRequestAuthState } from "../auth/scope"

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

export function registerAgentApiGatewayRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  for (const route of AGENT_API_ROUTES) {
    const path = `${AGENT_API_GATEWAY_PREFIX}/:agentGatewayRunId/:agentGatewayCapability${route.path}`
    const handler = async (context: AgentApiGatewayRouteContext) =>
      handleAgentApiGatewayRequest({
        sixb,
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
  readonly sixb: Sixb<readonly OntologySource[]>
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

  const authState = await resolveAgentRunAuthState(input.sixb, {
    runId: input.agentRunId,
    capability: input.capability,
  })
  if (authState instanceof Response) {
    return authState
  }

  let body: ArrayBuffer | undefined
  try {
    body = await readRequestBody(input.request)
  } catch (error) {
    if (isSixbError(error, "runtime.payload_too_large")) {
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
  sixb: Sixb<readonly OntologySource[]>,
  input: { readonly runId: string; readonly capability: string }
) {
  const agentStorage = sixb.storage.agents
  const workflowRuns = sixb.storage.workflowRuns
  if (!agentStorage && !workflowRuns) {
    // 501, not 403: nothing about the caller is being refused — neither storage role
    // that could hold an agent run is configured, so no request can ever succeed here.
    return jsonError(501, "Agent API gateway is not configured for this runtime.")
  }

  const conversationalRun = await agentStorage?.runs.getById({
    projectId: sixb.id,
    id: input.runId,
  })
  const workflowRun = conversationalRun
    ? null
    : await workflowRuns?.agentNodes.getByNodeRunId({
        projectId: sixb.id,
        nodeRunId: input.runId,
      })
  const run = conversationalRun ?? workflowRun
  if (
    !run ||
    run.status !== "running" ||
    !run.execution ||
    run.execution.queueLeaseExpiresAt.getTime() <= Date.now() ||
    !isValidAgentApiGatewayCapability({
      projectId: sixb.id,
      runId: input.runId,
      executionToken: run.execution.token,
      capability: input.capability,
    })
  ) {
    return jsonError(403, "Agent API gateway capability is not valid for this run.")
  }

  if (!sixb.auth.isEnabled()) {
    return {
      authz: null,
      scoped: null,
      ...(conversationalRun ? { agentRun: conversationalRun } : {}),
    }
  }

  // Two different failures shared one status. Missing auth storage is a runtime the
  // operator did not configure; a run without an execution principal is a run that
  // cannot prove an identity. Only the first is a 501.
  const auth = sixb.storage.auth
  if (!auth) {
    return jsonError(501, "Agent API gateway is not configured for authenticated agent access.")
  }
  if (!run.executionPrincipal) {
    return jsonError(403, "Agent run has no execution identity.")
  }

  const serviceAccount = await auth.serviceAccounts.getById({
    projectId: sixb.id,
    id: run.executionPrincipal.id,
  })
  if (!serviceAccount || serviceAccount.status !== "active") {
    return jsonError(403, "Agent execution identity is not active.")
  }

  const memberships = await auth.serviceAccountGroupMemberships.listForServiceAccount({
    projectId: sixb.id,
    serviceAccountId: serviceAccount.id,
  })
  const authz = resolveAuthorizationContext({
    principal: run.executionPrincipal,
    groupIds: memberships.map((membership) => membership.groupId),
    roles: sixb.security.listResolvedRoles(),
  })

  return {
    authz,
    scoped: sixb.as(authz),
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

async function readRequestBody(request: Request): Promise<ArrayBuffer | undefined> {
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
    if (total > MAX_AGENT_API_BODY_BYTES) {
      throw new SixbError(
        "runtime.payload_too_large",
        "[SixbServer] Agent API gateway request body exceeds 1MB."
      )
    }
    chunks.push(value)
  }

  return concatChunks(chunks, total)
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
