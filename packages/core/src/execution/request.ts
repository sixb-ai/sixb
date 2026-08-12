import { randomUUID } from "node:crypto"
import type { AuthorizationContext } from "../authorization"
import type { OntologySource } from "../ontology"
import { isBoundSixb, type Sixb } from "../runtime/sixb"
import { createDisabledRequestScope, createPrincipalRequestScope } from "./scopes"
import type { AuthorizationRef, ExecutionScope } from "./types"

export type { ActionRunsRuntime, ActionsRuntime } from "../actions/execution"
export type {
  AgentRunsRuntime,
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
  WorkflowInterventionsRuntime,
  WorkflowRunsRuntime,
  WorkflowsRuntime,
} from "../workflows/execution"
export type { AuthorizationRef, ExecutionContext } from "./types"

export type RequestExecutionAuthorization =
  | {
      readonly type: "principal"
      readonly context: AuthorizationContext
      readonly credential?: Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
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
  const scope =
    input.authorization.type === "principal"
      ? createPrincipalRequestScope({
          projectId: host.id,
          requestId,
          correlationId,
          context: input.authorization.context,
          ...(input.authorization.credential === undefined
            ? {}
            : { credential: input.authorization.credential }),
        })
      : createDisabledRequestScope({ projectId: host.id, requestId, correlationId })

  const sixb = host.withScope(scope)
  if (!isBoundSixb(sixb)) {
    throw new Error("[Sixb] Request host did not return an execution-bound Sixb SDK.")
  }
  return sixb
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
