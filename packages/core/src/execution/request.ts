import { randomUUID } from "node:crypto"
import type { AuthorizationContext, RuntimeAccessPlan } from "../authorization"
import type { OntologySource } from "../ontology"
import { isBoundSixb, type Sixb } from "../runtime/sixb"
import type { DelegatedExecutionLimits } from "./limits"
import {
  createDelegatedRequestScope,
  createDisabledRequestScope,
  createPrincipalRequestScope,
} from "./scopes"
import type { AuthorizationRef, ExecutionScope } from "./types"

export type {
  ActionDescriptor,
  ActionDescriptorBinding,
  ActionParamDescriptor,
  ActionPhaseDescriptor,
} from "../actions/descriptor"
export type { ActionRunsRuntime, ActionsRuntime } from "../actions/execution"
export type {
  AgentRunListResult,
  AgentRunsRuntime,
  AgentRunView,
  AgentsRuntime,
  AgentThreadsRuntime,
  CreateExecutionAgentThreadInput,
  ExecutionAgentRequestInput,
  ListExecutionAgentThreadsInput,
} from "../agents/execution"
export type { AuthorizationContext } from "../authorization"
export type { DatasetsRuntime } from "../datasets/execution"
export type { EventsRuntime } from "../events/execution"
export type { LogsRuntime } from "../logging/execution"
export type {
  ExecutionObjectByIdHandle,
  ExecutionObjectSet,
  ObjectsRuntime,
} from "../objects/execution"
export type {
  PipelineRunsRuntime,
  PipelinesRuntime,
} from "../pipelines/execution"
export type {
  ProjectionRunsRuntime,
  ProjectionsRuntime,
} from "../projections/execution"
export type { RuleStatesRuntime, RulesRuntime } from "../rules/execution"
export type { Sixb } from "../runtime/sixb"
export type { SyncRunsRuntime, SyncsRuntime } from "../syncs/execution"
export type {
  LatestWorkflowRunListResult,
  ListWorkflowRunNodesInput,
  WorkflowAgentNodeRunView,
  WorkflowInterventionsRuntime,
  WorkflowNodeRunListResult,
  WorkflowNodeRunView,
  WorkflowRunListResult,
  WorkflowRunsRuntime,
  WorkflowRunView,
  WorkflowsRuntime,
} from "../workflows/execution"
export type { AuthorizationRef, ExecutionContext } from "./types"

export type RequestExecutionAuthorization =
  | {
      readonly type: "principal"
      readonly context: AuthorizationContext
      readonly credential?: Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
    }
  | {
      readonly type: "delegated"
      readonly access: RuntimeAccessPlan
      readonly limits?: DelegatedExecutionLimits
      readonly delegation: {
        readonly kind: "share"
        readonly id: string
        readonly sessionId: string
      }
    }
  | { readonly type: "disabled" }

export interface BindRequestExecutionInput {
  readonly request: Request
  readonly authorization: RequestExecutionAuthorization
}

export interface RequestExecutionHost {
  readonly id: string
  withScope(scope: ExecutionScope): object
}

/** Bind one HTTP or WebSocket request without exposing trusted or kernel capability factories. */
export function bindRequestExecution(
  host: RequestExecutionHost,
  input: BindRequestExecutionInput
): Sixb<readonly OntologySource[]> {
  const requestId = requestIdentifier(input.request)
  const correlationId = correlationIdentifier(input.request, requestId)
  const scope = createRequestScope(host.id, requestId, correlationId, input.authorization)

  const sixb = host.withScope(scope)
  if (!isBoundSixb(sixb)) {
    throw new Error("[Sixb] Request host did not return an execution-bound Sixb SDK.")
  }
  return sixb
}

function createRequestScope(
  projectId: string,
  requestId: string,
  correlationId: string,
  authorization: RequestExecutionAuthorization
): ExecutionScope {
  switch (authorization.type) {
    case "principal":
      return createPrincipalRequestScope({
        projectId,
        requestId,
        correlationId,
        context: authorization.context,
        ...(authorization.credential === undefined ? {} : { credential: authorization.credential }),
      })
    case "delegated":
      return createDelegatedRequestScope({
        projectId,
        requestId,
        correlationId,
        access: authorization.access,
        ...(authorization.limits === undefined ? {} : { limits: authorization.limits }),
        delegation: authorization.delegation,
      })
    case "disabled":
      return createDisabledRequestScope({ projectId, requestId, correlationId })
  }
}

function requestIdentifier(request: Request): string {
  return headerIdentifier(request, "x-request-id") ?? `req_${randomUUID()}`
}

function correlationIdentifier(request: Request, requestId: string): string {
  return headerIdentifier(request, "x-correlation-id") ?? requestId
}

function headerIdentifier(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim()
  return value ? value : undefined
}
