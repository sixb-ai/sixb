import { type PreparedActionRequest, prepareActionRequest } from "../actions/request"
import type { SixbRuntimeContext } from "../runtime/types"
import { WorkflowValidationError } from "../workflows/errors"
import { type PreparedWorkflowRequest, prepareWorkflowRequest } from "../workflows/request"
import type { WorkflowDefinition } from "../workflows/types"
import type { ExecutionContext } from "./types"

export interface ActionRequestToPrepare {
  readonly actionId: string
  readonly subject?: PreparedActionRequest["subject"]
  readonly params?: Record<string, unknown>
}

export interface WorkflowRequestToPrepare {
  readonly workflowId: string
  readonly input?: Readonly<Record<string, unknown>>
}

/** Admit a request with a bound SDK's authority, as it would run, without running it. */
interface RequestPreparation {
  action(input: ActionRequestToPrepare): Promise<PreparedActionRequest>
  workflow(input: WorkflowRequestToPrepare): PreparedWorkflowRequest
}

const preparationKey = Symbol("sixb.requestPreparation")

interface PreparationOwner {
  readonly [preparationKey]?: RequestPreparation
}

/** Let infrastructure prepare requests with a bound SDK's authority. */
export function registerRequestPreparation(
  owner: object,
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  workflows: { getById(workflowId: string): WorkflowDefinition | null }
): void {
  const preparation: RequestPreparation = {
    action: (input) => prepareActionRequest(runtime, execution, input),
    workflow: (input) => {
      const workflow = workflows.getById(input.workflowId)
      if (!workflow) {
        throw new WorkflowValidationError(`[Sixb] Unknown workflow '${input.workflowId}'`)
      }
      return prepareWorkflowRequest(runtime, execution, workflow, input.input)
    },
  }
  Object.defineProperty(owner, preparationKey, {
    configurable: false,
    enumerable: false,
    value: preparation,
    writable: false,
  })
}

/** Admit an Action request as `sixb.actions.request` would, and return it normalized. */
export function prepareBoundActionRequest(
  sixb: object,
  input: ActionRequestToPrepare
): Promise<PreparedActionRequest> {
  return requirePreparation(sixb).action(input)
}

/** Admit a workflow start as `sixb.workflows.requestById` would, and return its input snapshot. */
export function prepareBoundWorkflowRequest(
  sixb: object,
  input: WorkflowRequestToPrepare
): PreparedWorkflowRequest {
  return requirePreparation(sixb).workflow(input)
}

function requirePreparation(sixb: object): RequestPreparation {
  const preparation = (sixb as PreparationOwner)[preparationKey]
  if (!preparation) {
    throw new Error("[Sixb] Request preparation is not registered for this execution.")
  }
  return preparation
}
