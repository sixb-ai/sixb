import type { SixbHostView } from "@sixb/core"
import {
  type AgentRunExecutionScope,
  AgentRunScopeError,
  agentRunTokenRunId,
  findAgentApiRoute,
  isAgentRunToken,
  isAllowedAgentApiRequest,
  isValidAgentRunToken,
  resolveAgentRunExecutionScope,
} from "@sixb/core/internal/agents"
import { normalizeRoutePath, pathSegmentsFor } from "@sixb/core/internal/http"
import type {
  AgentRunRecord,
  ConversationAgentRunRecord,
  SubagentRunRecord,
  WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"
import { gateAgentApiCall } from "../routes/agent-approval-gate"
import { readRequestBodyWithLimit } from "../utils/request-body"
import type { AgentRunRequestExecution, RequestAuthState } from "./scope"

// An Agent's commands call the API with their run's token, as `Authorization: Bearer`. The token
// opens only the routes `SIXB_API_ROUTES` marks `agentApi`, and each request runs inside the run's
// own execution, restored from server-side records: what it starts is a child of the run and keeps
// the run's requester, whatever the request's headers say. What a run may do there depends on its
// kind, and on its conversation's approval mode, as decided below.

/** What a run-token request is allowed as, or the answer that refuses or holds it. */
export type RunTokenDecision =
  | { readonly kind: "deny"; readonly response: Response }
  | { readonly kind: "allow"; readonly state: RunTokenAuthState }

export interface RunTokenAuthState {
  readonly runExecution: AgentRunRequestExecution
  readonly agentRun?: AgentRunRecord
  readonly agentExecution: NonNullable<RequestAuthState["agentExecution"]>
}

/** The run token a request carries, if any: any other credential is not this boundary's. */
export function requestRunToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization")
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
  return token !== undefined && isAgentRunToken(token) ? token : undefined
}

/** The most of a call's body the approval gate reads, from a copy its route still reads whole. */
const MAX_GATED_BODY_BYTES = 1_000_000

/**
 * Admit a run-token request, before its route parses it: its route, its run, the rules of the
 * run's kind, and the approval its call needs.
 */
export async function resolveRunTokenRequest(input: {
  readonly host: SixbHostView
  readonly request: Request
  readonly token: string
}): Promise<RunTokenDecision> {
  const { host, request } = input
  const method = request.method.toUpperCase()
  const path = normalizeRoutePath(new URL(request.url).pathname)
  if (!isAllowedAgentApiRequest(method, path)) {
    return deny(403, `A run token cannot call ${method} ${path}.`)
  }

  const resolved = await resolveRunState(host, input.token)
  if (resolved.kind === "deny") return resolved
  const { state, run } = resolved

  const refused = await runPolicyRefusal(host, { method, path, state, run })
  if (refused) return refused

  // The run's approval mode decides, never the model: a held call does not reach its route.
  const gate = await gateAgentApiCall({
    host,
    method,
    upstreamPath: path,
    readBody: () =>
      readRequestBodyWithLimit(
        request.clone(),
        MAX_GATED_BODY_BYTES,
        "The request body exceeds 1MB, the most a call that may need approval can send."
      ),
    contentType: request.headers.get("content-type"),
    run,
    agentExecution: state.agentExecution,
    runExecution: state.runExecution,
    signal: request.signal,
  })
  if (gate.kind === "answer") return { kind: "deny", response: gate.response }

  return { kind: "allow", state }
}

/**
 * What a run of each kind may not do, whatever its requester's grants allow:
 * - a workflow step or a child starts no workflow;
 * - a workflow step has no memory: a conversation's notes must not change a fixed assignment;
 * - a workflow step publishes no artifact: it has no conversation to publish into;
 * - a child reads its conversation's memory but saves none, and changes nothing once its parent's
 *   turn has ended;
 * - a shared conversation reaches only the project's memory, whoever sends the turn.
 */
async function runPolicyRefusal(
  host: SixbHostView,
  input: {
    readonly method: string
    readonly path: string
    readonly state: RunTokenAuthState
    readonly run: AgentRunRecord | WorkflowAgentNodeRunRecord
  }
): Promise<RunTokenDecision | undefined> {
  const { method, path, state, run } = input
  const { kind } = state.agentExecution

  if (kind !== "conversation" && method === "POST" && matchesWorkflowRunStart(path)) {
    return deny(
      409,
      kind === "workflow"
        ? "Workflow agent nodes cannot start another workflow run."
        : "Child agents cannot start a workflow run."
    )
  }
  if (kind === "workflow" && matchesAgentMemory(path)) {
    return deny(403, "Workflow agent nodes have no Agent memory.")
  }
  if (kind === "workflow" && findAgentApiRoute(method, path)?.effect === "artifact") {
    return deny(403, "Workflow agent nodes publish no artifacts: they have no conversation.")
  }
  if ("kind" in run && run.kind === "subagent" && !(await parentRunActive(host, run))) {
    return deny(409, "The child agent's parent run has ended or been stopped.")
  }
  if (kind === "subagent" && method !== "GET" && matchesAgentMemory(path)) {
    return deny(403, "Child agents cannot save Agent memory.")
  }
  // Anything but the project's exact path is refused, as a route parameter is percent-decoded.
  if (
    state.agentRun?.kind === "conversation" &&
    matchesAgentMemory(path) &&
    pathSegmentsFor(path)[2] !== "project" &&
    (await hasParticipants(host, state.agentRun))
  ) {
    return deny(
      403,
      "A shared conversation reaches only the project's memory. Save nothing about one person here."
    )
  }
  return undefined
}

async function resolveRunState(
  host: SixbHostView,
  token: string
): Promise<
  | { readonly kind: "deny"; readonly response: Response }
  | {
      readonly kind: "allow"
      readonly state: RunTokenAuthState
      readonly run: AgentRunRecord | WorkflowAgentNodeRunRecord
    }
> {
  const agentStorage = host.storage.agents
  const workflowRuns = host.storage.workflowRuns
  if (!agentStorage && !workflowRuns) {
    // 501, not 403: nothing about the caller is being refused — neither storage role that could
    // hold an agent run is configured, so no request can ever succeed here.
    return deny(501, "Run tokens are not available: this runtime stores no agent runs.")
  }

  const runId = agentRunTokenRunId(token)
  const storedAgentRun = runId
    ? await agentStorage?.runs.getById({ projectId: host.id, id: runId })
    : undefined
  const workflowRun =
    runId && !storedAgentRun
      ? await workflowRuns?.agentNodes.getByNodeRunId({ projectId: host.id, nodeRunId: runId })
      : undefined
  const runState = toRunState(storedAgentRun ?? null, workflowRun ?? null)
  if (
    !runId ||
    !runState ||
    runState.run.status !== "running" ||
    ("cancelRequestedAt" in runState.run && runState.run.cancelRequestedAt) ||
    !runState.run.execution ||
    runState.run.execution.queueLeaseExpiresAt.getTime() <= Date.now() ||
    !isValidAgentRunToken({
      projectId: host.id,
      runId,
      executionToken: runState.run.execution.token,
      token,
    })
  ) {
    return deny(403, "The run token is not valid: its run has ended, moved or been stopped.")
  }

  let scope: AgentRunExecutionScope
  try {
    scope = await resolveAgentRunExecutionScope(host, {
      runId: runState.runId,
      executionId: runState.run.executionId,
      authority:
        runState.authority === "managed"
          ? { type: "managed", actorId: runState.actorId }
          : { type: "inherited" },
    })
  } catch (error) {
    if (!(error instanceof AgentRunScopeError)) throw error
    return scopeErrorResponse(error)
  }

  // Authority is the record's current grants, resolved on every request when it is admitted; a
  // request admitted before the run ends finishes under it, like an in-process tool call.
  return {
    kind: "allow",
    state: {
      runExecution: { ...scope, attempt: runState.run.attempt },
      agentExecution: runState.agentExecution,
      ...(runState.agentRun === undefined ? {} : { agentRun: runState.agentRun }),
    },
    run: runState.run,
  }
}

type RunState = {
  readonly run: AgentRunRecord | WorkflowAgentNodeRunRecord
  readonly runId: string
  readonly agentExecution: NonNullable<RequestAuthState["agentExecution"]>
  readonly agentRun?: ConversationAgentRunRecord
} & (
  | { readonly authority: "inherited" }
  | { readonly authority: "managed"; readonly actorId: string }
)

function toRunState(
  storedRun: AgentRunRecord | null,
  workflowRun: WorkflowAgentNodeRunRecord | null
): RunState | null {
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
    return {
      run: storedRun,
      runId: storedRun.id,
      agentExecution: { kind: "conversation", runId: storedRun.id },
      agentRun: storedRun,
      authority: "inherited",
    }
  }

  if (!workflowRun) return null
  return {
    run: workflowRun,
    runId: workflowRun.nodeRunId,
    agentExecution: { kind: "workflow", nodeRunId: workflowRun.nodeRunId },
    authority: "managed",
    actorId: workflowRun.actorId,
  }
}

function scopeErrorResponse(
  error: AgentRunScopeError
): RunTokenDecision & { readonly kind: "deny" } {
  switch (error.code) {
    case "execution_unavailable":
      return deny(403, "Agent run execution is not available.")
    case "auth_unavailable":
      return deny(
        501,
        "Run tokens are not available: authenticated agent access is not configured."
      )
    case "authority_invalid":
      return deny(403, "Agent run execution authority is not valid.")
  }
}

async function parentRunActive(host: SixbHostView, run: SubagentRunRecord): Promise<boolean> {
  const parent = await host.storage.agents?.runs.getById({
    projectId: host.id,
    id: run.parentRunId,
  })
  return (parent?.status === "queued" || parent?.status === "running") && !parent.cancelRequestedAt
}

function matchesAgentMemory(pathname: string): boolean {
  const segments = pathSegmentsFor(pathname)
  return segments[0] === "api" && segments[1] === "agent-memory"
}

/** Anyone added to the run's thread, even one who cannot read it now, as the worker counts them. */
async function hasParticipants(
  host: SixbHostView,
  run: ConversationAgentRunRecord
): Promise<boolean> {
  const participants = await host.storage.agents?.threads.listParticipants({
    projectId: run.projectId,
    threadIds: [run.threadId],
  })
  return (participants?.length ?? 0) > 0
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

function deny(status: number, message: string): RunTokenDecision & { readonly kind: "deny" } {
  return { kind: "deny", response: Response.json({ error: message }, { status }) }
}
