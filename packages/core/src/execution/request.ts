import { randomUUID } from "node:crypto"
import type { AuthorizationContext } from "../authorization"
import type { OntologySource } from "../ontology"
import { isBoundSixb, type Sixb } from "../runtime/sixb"
import {
  objectReadScopeForAccessPlan,
  type ShareAccessPlan,
  snapshotShareAccessPlan,
} from "../shares/access-plan"
import type { ObjectReadExecutionLimits } from "../storage/objects/execution-limits"
import {
  createDelegatedRequestScope,
  createDisabledRequestScope,
  createPrincipalRequestScope,
} from "./scopes"
import type { AuthorizationRef, ExecutionScope } from "./types"

export type { ActionRunsRuntime, ActionsRuntime } from "../actions/execution"
export type {
  AgentRunListResult,
  AgentRunsRuntime,
  AgentRuntime,
  AgentRunView,
  AgentThreadsRuntime,
  CreateExecutionAgentThreadInput,
  ExecutionAgentRequestInput,
  ExecutionAgentRunResult,
  ListExecutionAgentThreadsInput,
} from "../agents/execution"
export type { AgentDescriptor } from "../agents/types"
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
export type { AgentThreadRecord, ListAgentThreadsResult } from "../storage/agents"
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
      readonly access: ShareAccessPlan
      readonly limits?: ObjectReadExecutionLimits
      readonly delegation: {
        readonly kind: "share"
        readonly grantId: string
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
    case "delegated": {
      const access = snapshotShareAccessPlan(authorization.access)
      return createDelegatedRequestScope({
        projectId,
        requestId,
        correlationId,
        objectRead: {
          selection: objectReadScopeForAccessPlan(access),
          limits: authorization.limits ?? {
            maxTraversalFacts: 10_000,
            maxOutputJsonBytes: 8 * 1024 * 1024,
          },
        },
        actionApply: access.grants.flatMap((grant) =>
          grant.kind === "action.apply"
            ? grant.subjects.map((subject) => ({ actionId: grant.actionId, subject }))
            : []
        ),
        delegation: authorization.delegation,
      })
    }
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
