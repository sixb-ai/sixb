import type { SixbHostView } from "@sixb/core"
import { bindAgentGatewayRequestExecution } from "@sixb/core/internal/agent-execution"
import {
  agentRunApprovalMode,
  announceAgentApprovals,
  approvalCallSummary,
  findAgentApiRoute,
  holdAgentApprovalCall,
} from "@sixb/core/internal/agents"
import { pathSegmentsFor } from "@sixb/core/internal/http"
import {
  prepareBoundActionRequest,
  prepareBoundWorkflowRequest,
} from "@sixb/core/internal/request-execution"
import {
  type AgentApprovalCall,
  type AgentApprovalRecord,
  type AgentRunRecord,
  AgentStorageError,
  type WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"
import { ZodError, type z } from "zod"
import type { AgentGatewayRunExecution, RequestAuthState } from "../auth/scope"
import { RequestActionBodySchema } from "../schemas/actions"
import { RequestWorkflowRunBodySchema } from "../schemas/workflows"
import { handleRouteError } from "../utils/http"

/** What the gateway does with an Agent's call: forward it, or answer it itself. */
export type AgentApiGate =
  | { readonly kind: "pass" }
  | { readonly kind: "answer"; readonly response: Response }

export interface AgentApiGateInput {
  readonly host: SixbHostView
  readonly method: string
  readonly upstreamPath: string
  readonly body: Uint8Array | undefined
  readonly run: AgentRunRecord | WorkflowAgentNodeRunRecord
  readonly agentExecution: NonNullable<RequestAuthState["agentExecution"]>
  readonly runExecution: AgentGatewayRunExecution
  readonly signal: AbortSignal
}

/**
 * Hold an action or a workflow start the turn's approval mode does not run. Core decides; this
 * reads the call the way its route would, and answers for it. A call the route would refuse is
 * refused here, before anything is held.
 */
export async function gateAgentApiCall(input: AgentApiGateInput): Promise<AgentApiGate> {
  const effect = findAgentApiRoute(input.method, input.upstreamPath)?.effect
  if (effect !== "action" && effect !== "workflow") return { kind: "pass" }
  // A workflow AI task runs on its own: it has no mode.
  if (input.agentExecution.kind === "workflow" || !isAgentRun(input.run)) return { kind: "pass" }
  if (agentRunApprovalMode(input.run) === "auto") return { kind: "pass" }

  try {
    const call = effect === "action" ? await prepareActionCall(input) : prepareWorkflowCall(input)
    return await answerHold(input, input.run, call)
  } catch (error) {
    if (error instanceof GateRefusal) return { kind: "answer", response: error.response }
    throw error
  }
}

async function answerHold(
  input: AgentApiGateInput,
  run: AgentRunRecord,
  call: AgentApprovalCall
): Promise<AgentApiGate> {
  const agents = input.host.storage.agents
  if (!agents) throw refusal(501, "Agent approvals are not configured for this runtime.")

  let hold: Awaited<ReturnType<typeof holdAgentApprovalCall>>
  try {
    hold = await holdAgentApprovalCall(agents, {
      projectId: input.host.id,
      run,
      requestedBy: input.runExecution.execution.requestedBy,
      call,
    })
  } catch (error) {
    // The run ended, or its delivery changed, since the gateway checked its capability.
    if (!(error instanceof AgentStorageError)) throw error
    throw refusal(403, "Agent API gateway capability is not valid for this run.")
  }

  switch (hold.kind) {
    case "pass":
      return { kind: "pass" }
    case "held":
      // Announced on every answer: the feed keeps one record per change.
      await announceAgentApprovals(input.host.broker, [hold.approval])
      return {
        kind: "answer",
        response: Response.json(heldCallBody(hold.approval), { status: 202 }),
      }
    case "denied":
      throw refusal(403, "The user denied this request. It did not run.")
    case "conflict":
      throw refusal(
        409,
        `Run id '${hold.approval.callKey}' already names another request in this conversation. Name a new run.`
      )
  }
}

function isAgentRun(run: AgentRunRecord | WorkflowAgentNodeRunRecord): run is AgentRunRecord {
  return "kind" in run
}

/** The Action call as its route would run it: admitted, with its params normalized. */
async function prepareActionCall(input: AgentApiGateInput): Promise<AgentApprovalCall> {
  const body = parseBody(input.body, RequestActionBodySchema)
  const actionRunId = requiredRunId(body.runId)

  try {
    const prepared = await prepareBoundActionRequest(boundSixb(input), {
      actionId: pathParam(input.upstreamPath),
      ...(body.subject === undefined ? {} : { subject: body.subject }),
      ...(body.params === undefined ? {} : { params: body.params }),
    })
    return { kind: "action", ...prepared, actionRunId }
  } catch (error) {
    throw routeRefusal(error)
  }
}

/** The workflow start as its route would run it: admitted, with its input snapshotted. */
function prepareWorkflowCall(input: AgentApiGateInput): AgentApprovalCall {
  const body = parseBody(input.body, RequestWorkflowRunBodySchema)
  const workflowRunId = requiredRunId(body.runId)

  try {
    const prepared = prepareBoundWorkflowRequest(boundSixb(input), {
      workflowId: pathParam(input.upstreamPath),
      input: body.input ?? {},
    })
    return { kind: "workflow", ...prepared, workflowRunId }
  } catch (error) {
    throw routeRefusal(error)
  }
}

function boundSixb(input: AgentApiGateInput): object {
  return bindAgentGatewayRequestExecution(input.host, {
    signal: input.signal,
    ...input.runExecution,
  })
}

/** The run id the call names is what keeps a repeated request to one approval and one run. */
function requiredRunId(runId: string | undefined): string {
  if (runId !== undefined) return runId
  throw refusal(
    400,
    "This request needs the user's approval, so it must name its run: pass a non-empty runId."
  )
}

/** `/api/actions/:actionId` and `/api/workflows/:workflowId/runs` name their target third. */
function pathParam(upstreamPath: string): string {
  const segment = pathSegmentsFor(upstreamPath)[2] ?? ""
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Parsed with the route's own schema, so the gate reads the body the route would. */
function parseBody<TSchema extends z.ZodTypeAny>(
  body: Uint8Array | undefined,
  schema: TSchema
): z.output<TSchema> {
  try {
    const text = body && body.byteLength > 0 ? new TextDecoder().decode(body) : "{}"
    return schema.parse(JSON.parse(text))
  } catch (error) {
    if (error instanceof SyntaxError) throw refusal(400, "The request body must be valid JSON.")
    if (error instanceof ZodError) throw refusal(400, "The request body is not valid.")
    throw error
  }
}

/** The gate answers for the call itself: it never reaches its route. */
class GateRefusal extends Error {
  constructor(readonly response: Response) {
    super("[SixbServer] The agent API gateway answered the call itself.")
  }
}

function refusal(status: number, message: string): GateRefusal {
  return new GateRefusal(Response.json({ error: message }, { status }))
}

/** A call the route would refuse is answered as the route would answer it. */
function routeRefusal(error: unknown): GateRefusal {
  const set: { status?: number | string } = {}
  const body = handleRouteError(error, set)
  return new GateRefusal(
    Response.json(body, { status: typeof set.status === "number" ? set.status : 500 })
  )
}

/** What the CLI prints for a held call: the model reads it and ends its turn. */
function heldCallBody(approval: AgentApprovalRecord) {
  return {
    status: "awaiting_approval",
    approval: { id: approval.id, ...approvalCallSummary(approval.call) },
    message:
      "The user approves or denies this in the conversation. Do not retry it or ask in text; end your turn.",
  } as const
}
