import { createDelegatedRequestScope } from "../src/execution/scopes"
import type { SharedAccessDelegationRef } from "../src/execution/types"
import {
  objectReadScopeForAccessPlan,
  type ShareAccessPlan,
  snapshotShareAccessPlan,
} from "../src/shares/access-plan"
import type { ObjectReadExecutionLimits } from "../src/storage"

/** Runtime fixtures; HTTP tests exercise the production request binding separately. */
export function createSharedTestScope(input: {
  readonly projectId: string
  readonly requestId: string
  readonly correlationId: string
  readonly access: ShareAccessPlan
  readonly limits?: ObjectReadExecutionLimits
  readonly delegation: SharedAccessDelegationRef
}) {
  const access = snapshotShareAccessPlan(input.access)
  return createDelegatedRequestScope({
    projectId: input.projectId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    objectRead: {
      selection: objectReadScopeForAccessPlan(access),
      limits: input.limits ?? { maxTraversalFacts: 10_000, maxOutputJsonBytes: 8 * 1024 * 1024 },
    },
    actionApply: access.grants.flatMap((grant) =>
      grant.kind === "action.apply"
        ? grant.subjects.map((subject) => ({ actionId: grant.actionId, subject }))
        : []
    ),
    delegation: input.delegation,
  })
}
