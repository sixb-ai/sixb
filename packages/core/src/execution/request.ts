import { randomUUID } from "node:crypto"
import type { AuthorizationContext } from "../authorization"
import type { OntologySource } from "../ontology"
import { bindExecution } from "../runtime/execution-binding"
import type { ExecutionSixb } from "../runtime/scoped"
import type { Sixb } from "../runtime/sixb"
import { createDisabledRequestScope, createPrincipalRequestScope } from "./scopes"
import type { AuthorizationRef } from "./types"

export type { ExecutionActionRunsRuntime, ExecutionActionsRuntime } from "../actions/execution"
export type {
  CreateExecutionAgentThreadInput,
  ExecutionAgentRequestInput,
  ExecutionAgentRunsRuntime,
  ExecutionAgentsRuntime,
  ExecutionAgentThreadsRuntime,
  ListExecutionAgentThreadsInput,
} from "../agents/execution"
export type { AuthorizationContext } from "../authorization"
export type { ExecutionDatasetsRuntime } from "../datasets/execution"
export type { ExecutionEventsRuntime } from "../events/execution"
export type { ExecutionLogsRuntime } from "../logging/execution"
export type {
  ExecutionObjectByIdHandle,
  ExecutionObjectSet,
  ExecutionObjectsRuntime,
} from "../objects/execution"
export type {
  ExecutionPipelineRunsRuntime,
  ExecutionPipelinesRuntime,
} from "../pipelines/execution"
export type {
  ExecutionProjectionRunsRuntime,
  ExecutionProjectionsRuntime,
} from "../projections/execution"
export type { ExecutionRuleStatesRuntime, ExecutionRulesRuntime } from "../rules/execution"
export type { ExecutionSixb } from "../runtime/scoped"
export type { ExecutionSyncRunsRuntime, ExecutionSyncsRuntime } from "../syncs/execution"
export type {
  ExecutionWorkflowInterventionsRuntime,
  ExecutionWorkflowRunsRuntime,
  ExecutionWorkflowsRuntime,
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

/** Bind one HTTP or WebSocket request without exposing trusted or kernel capability factories. */
export function bindRequestExecution(
  host: Sixb<readonly OntologySource[]>,
  input: BindRequestExecutionInput
): ExecutionSixb<readonly OntologySource[]> {
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

  return bindExecution<readonly OntologySource[]>(host, scope)
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
