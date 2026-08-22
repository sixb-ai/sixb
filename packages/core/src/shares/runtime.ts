import type { RequestActionResult } from "../actions"
import { emptyGrantSets } from "../authorization/grant-kinds"
import type { GrantIndex } from "../authorization/types"
import { type RequestExecutionHost, requestExecutionIdentifiers } from "../execution/request"
import { createSharedAccessRequestScope } from "../execution/scopes"
import { isBoundSixb } from "../runtime/sixb"
import { ObjectNotFoundError, type ObjectRow } from "../storage"
import type { SharedAccessSessionContext } from "./protocol"

export interface SharedAccessActionInput {
  readonly params?: Record<string, unknown>
  readonly runId?: string
  readonly signal?: AbortSignal
}

/** The only domain operations exposed to a shared request. Its target is fixed by the grant. */
export interface SharedAccessExecution {
  getResource(): Promise<ObjectRow | null>
  requestAction(actionId: string, input?: SharedAccessActionInput): Promise<RequestActionResult>
}

export function bindSharedAccessExecution(
  host: RequestExecutionHost,
  input: {
    readonly request: Request
    readonly context: SharedAccessSessionContext
  }
): SharedAccessExecution {
  assertContextIdentity(host.id, input.context)
  const { requestId, correlationId } = requestExecutionIdentifiers(input.request)
  const scope = createSharedAccessRequestScope({
    projectId: host.id,
    requestId,
    correlationId,
    principal: input.context.principal,
    grants: effectiveGrantIndex(input.context),
  })
  const sixb = host.withScope(scope)
  if (!isBoundSixb(sixb)) {
    throw new Error("[Sixb] Shared access host did not return an execution-bound Sixb SDK.")
  }

  const target = Object.freeze({ ...input.context.grant.target })
  const getResource = () => sixb.objects.get(target.objectTypeId, target.primaryId)

  return Object.freeze({
    getResource,
    async requestAction(actionId: string, actionInput: SharedAccessActionInput = {}) {
      if (!(await getResource())) {
        throw new ObjectNotFoundError(
          target.objectTypeId,
          target.primaryId,
          "Shared resource not found"
        )
      }
      return sixb.actions.request({
        actionId,
        ...actionInput,
        subject: {
          kind: "object",
          objectTypeId: target.objectTypeId,
          primaryId: target.primaryId,
        },
      })
    },
  })
}

function effectiveGrantIndex(context: SharedAccessSessionContext): GrantIndex {
  const grants = emptyGrantSets()
  for (const grant of context.effectiveGrants) {
    if (grant.capability === "view") {
      if (grant.objectTypeId !== context.grant.target.objectTypeId) {
        throw new Error("[Sixb] Shared view authority must match the exact grant target type.")
      }
      grants["view:object"].add(grant.objectTypeId)
      continue
    }
    if (!grant.actionId.trim()) {
      throw new Error("[Sixb] Shared action authority must not be empty.")
    }
    grants["apply:action"].add(grant.actionId)
  }
  return grants
}

function assertContextIdentity(projectId: string, context: SharedAccessSessionContext): void {
  if (
    context.grant.projectId !== projectId ||
    context.session.projectId !== projectId ||
    context.principal.grantId !== context.grant.id ||
    context.principal.sessionId !== context.session.id ||
    context.session.grantId !== context.grant.id
  ) {
    throw new Error("[Sixb] Shared access context has inconsistent grant or session identity.")
  }
  if (!context.grant.target.objectTypeId.trim() || !context.grant.target.primaryId.trim()) {
    throw new Error("[Sixb] Shared access context must contain an exact object target.")
  }
}
