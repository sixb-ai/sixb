import type { Principal } from "../auth/types"
import type { RoleDefinition, Selection } from "../security"
import type { AuthorizationContext, GrantIndex, ResolvedRole } from "./types"

/**
 * Expand a role's grants into concrete id sets once at startup.
 *
 * Broad grants (`ontology.objects().except(...)`) expand against the registered
 * universe; explicit object grants expand to subtypes. The result holds only
 * `Set`s, so per-request resolution and runtime checks stay simple `set.has`.
 */
export function resolveRoleGrants(
  role: RoleDefinition,
  universe: {
    readonly objectTypeIds: ReadonlySet<string>
    readonly datasetIds: ReadonlySet<string>
    readonly actionIds: ReadonlySet<string>
    readonly workflowIds: ReadonlySet<string>
    readonly syncIds: ReadonlySet<string>
    readonly pipelineIds: ReadonlySet<string>
    readonly getSubTypes: (objectTypeId: string) => readonly string[]
  }
): GrantIndex {
  const viewObjects = new Set<string>()
  const viewDatasets = new Set<string>()
  const apply = new Set<string>()
  const runWorkflows = new Set<string>()
  const runSyncs = new Set<string>()
  const runPipelines = new Set<string>()

  for (const grant of role.grants) {
    switch (grant.capability) {
      case "view":
        if ((grant.target ?? "object") === "dataset") {
          expandSelection(grant.selection, universe.datasetIds, viewDatasets)
        } else {
          expandSelection(
            grant.selection,
            universe.objectTypeIds,
            viewObjects,
            universe.getSubTypes
          )
        }
        break
      case "apply":
        expandSelection(grant.selection, universe.actionIds, apply)
        break
      case "run":
        switch (grant.target ?? "workflow") {
          case "sync":
            expandSelection(grant.selection, universe.syncIds, runSyncs)
            break
          case "pipeline":
            expandSelection(grant.selection, universe.pipelineIds, runPipelines)
            break
          case "workflow":
            expandSelection(grant.selection, universe.workflowIds, runWorkflows)
            break
        }
        break
    }
  }

  return {
    objectTypes: { view: viewObjects },
    datasets: { view: viewDatasets },
    actions: { apply },
    workflows: { run: runWorkflows },
    syncs: { run: runSyncs },
    pipelines: { run: runPipelines },
  }
}

function expandSelection(
  selection: Selection,
  universe: ReadonlySet<string>,
  into: Set<string>,
  expand?: (id: string) => readonly string[]
): void {
  if (selection.all) {
    const except = new Set(selection.except)
    for (const id of universe) {
      if (!except.has(id)) {
        into.add(id)
      }
    }
    return
  }

  for (const id of selection.ids) {
    into.add(id)
    if (expand) {
      for (const subTypeId of expand(id)) {
        into.add(subTypeId)
      }
    }
  }
}

/**
 * Resolve a principal's authorization context from its group memberships.
 *
 * Pure set-union over pre-resolved roles: roles match when their grantedTo
 * groups intersect the principal's memberships, and their concrete id sets
 * union into the principal's grant index.
 */
export function resolveAuthorizationContext(input: {
  readonly principal: Principal
  readonly sessionId?: string
  readonly groupIds: readonly string[]
  readonly roles: readonly ResolvedRole[]
}): AuthorizationContext {
  const memberGroupIds = new Set(input.groupIds)
  const roleIds: string[] = []
  const viewObjects = new Set<string>()
  const viewDatasets = new Set<string>()
  const apply = new Set<string>()
  const runWorkflows = new Set<string>()
  const runSyncs = new Set<string>()
  const runPipelines = new Set<string>()

  for (const role of input.roles) {
    if (!role.grantedToGroupIds.some((groupId) => memberGroupIds.has(groupId))) {
      continue
    }

    roleIds.push(role.id)
    for (const id of role.grants.objectTypes.view) {
      viewObjects.add(id)
    }
    for (const id of role.grants.datasets.view) {
      viewDatasets.add(id)
    }
    for (const id of role.grants.actions.apply) {
      apply.add(id)
    }
    for (const id of role.grants.workflows.run) {
      runWorkflows.add(id)
    }
    for (const id of role.grants.syncs.run) {
      runSyncs.add(id)
    }
    for (const id of role.grants.pipelines.run) {
      runPipelines.add(id)
    }
  }

  return {
    principal: input.principal,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    groupIds: input.groupIds,
    roleIds,
    grants: {
      objectTypes: { view: viewObjects },
      datasets: { view: viewDatasets },
      actions: { apply },
      workflows: { run: runWorkflows },
      syncs: { run: runSyncs },
      pipelines: { run: runPipelines },
    },
  }
}
