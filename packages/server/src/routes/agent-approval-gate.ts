import type { SixbHostView } from "@sixb/core"
import { bindAgentRunRequestExecution } from "@sixb/core/internal/agent-execution"
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
import type { AgentRunRequestExecution, RequestAuthState } from "../auth/scope"
import { RequestActionBodySchema } from "../schemas/actions"
import { RequestWorkflowRunBodySchema } from "../schemas/workflows"
import { handleRouteError } from "../utils/http"
import { RequestBodyTooLargeError } from "../utils/request-body"

/** What happens to an Agent's call: it goes on to its route, or is answered here. */
export type AgentApiGate =
  | { readonly kind: "pass" }
  | { readonly kind: "answer"; readonly response: Response }

export interface AgentApiGateInput {
  readonly host: SixbHostView
  readonly method: string
  readonly upstreamPath: string
  /** Read only for a call the gate may hold, so other calls' bodies stay unread. */
  readBody(): Promise<Uint8Array | undefined>
  /** The request's Content-Type: the route parses the body by it, so the gate must agree. */
  readonly contentType: string | null
  readonly run: AgentRunRecord | WorkflowAgentNodeRunRecord
  readonly agentExecution: NonNullable<RequestAuthState["agentExecution"]>
  readonly runExecution: AgentRunRequestExecution
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
    const call =
      effect === "action" ? await prepareActionCall(input) : await prepareWorkflowCall(input)
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
    // The run ended, or its delivery changed, since its token was checked.
    if (!(error instanceof AgentStorageError)) throw error
    throw refusal(403, "The run token is not valid: its run has ended or moved.")
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
  const body = parseBody(await readBody(input), RequestActionBodySchema)
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
async function prepareWorkflowCall(input: AgentApiGateInput): Promise<AgentApprovalCall> {
  const body = parseBody(await readBody(input), RequestWorkflowRunBodySchema)
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
  return bindAgentRunRequestExecution(input.host, {
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

/**
 * Parsed with the route's own schema, so the gate reads the body the route would. Only as JSON:
 * the route parses by Content-Type, so a body the two read differently would let an approved call
 * through as another.
 */
async function readBody(input: AgentApiGateInput): Promise<Uint8Array | undefined> {
  let body: Uint8Array | undefined
  try {
    body = await input.readBody()
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw refusal(413, error.message)
    throw error
  }
  // Exactly as the route reads it: Elysia cuts the type at ";" and matches it case-sensitively,
  // so `Application/JSON` reaches the route without a body.
  const mediaType = input.contentType?.split(";")[0]
  if (body && body.byteLength > 0 && mediaType !== "application/json") {
    throw refusal(415, "A call that may need approval sends its body as application/json.")
  }
  return body
}

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
    super("[SixbServer] The Agent's call was answered before its route.")
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
