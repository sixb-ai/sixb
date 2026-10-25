import { isRuntimeAllowed } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import { readerClearance, readerViewConditions } from "../execution/authorized-object-reader"
import type { DefinitionCatalog } from "../runtime/definitions"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ListActiveRuleStatesInput, ListActiveRuleStatesResult } from "../storage/rules"
import type { RuleDefinition } from "./types"

export interface RuleStatesRuntime {
  list(
    input?: Omit<ListActiveRuleStatesInput, "projectId" | "objectTypeIds">
  ): Promise<ListActiveRuleStatesResult>
}

export interface RulesRuntime {
  list(): readonly RuleDefinition[]
  getById(ruleId: string): RuleDefinition | null
  readonly states: RuleStatesRuntime
}

export function createRulesRuntime(
  runtime: SixbRuntimeContext,
  source: DefinitionCatalog<RuleDefinition>
): RulesRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)

  // A rule on a type the reader views under a condition shows: the reader sees some of its objects.
  const visible = (rule: RuleDefinition) => {
    if (authority.type === "denied" || authority.type === "delegated") return false

    const objectTypeId = rule.subject.objectTypeId
    return (
      isRuntimeAllowed(runtime, { kind: "object.view", objectTypeId }) ||
      readerViewConditions(runtime.objectReader).has(objectTypeId)
    )
  }

  return {
    list: () =>
      authority.type === "denied" || authority.type === "delegated"
        ? []
        : source.list().filter(visible),
    getById: (ruleId) => {
      if (authority.type === "denied" || authority.type === "delegated") return null
      const rule = source.getById(ruleId)
      return rule && visible(rule) ? rule : null
    },
    states: {
      list: async (input = {}) => {
        if (authority.type === "denied" || authority.type === "delegated") {
          return { states: [], hasMore: false, total: 0 }
        }
        const storage = runtime.storage.rules
        if (!storage) return { states: [], hasMore: false, total: 0 }
        if (authority.type === "unrestricted") {
          return storage.listActive({ ...input, projectId: runtime.projectId })
        }

        // A state names its subject's id: it shows where the reader could read that subject, under
        // the markings of the versions projections applied too.
        const clearance = await readerClearance(runtime.objectReader)

        // Storage cannot tell which objects of a type viewed under a condition the reader sees, so
        // their matches list one object at a time, once the reader reads it. A listing that names
        // no object leaves them out: it lists only the types the reader views whole.
        const { objectTypeId, primaryId } = input
        const conditions = readerViewConditions(runtime.objectReader)
        if (objectTypeId !== undefined && primaryId !== undefined && conditions.has(objectTypeId)) {
          if (conditions.get(objectTypeId)!.hiddenBy(clearance)) {
            return { states: [], hasMore: false, total: 0 }
          }

          const object = await runtime.objectReader.getByPrimaryId({ objectTypeId, primaryId })
          if (!object) return { states: [], hasMore: false, total: 0 }

          return storage.listActive({
            ...input,
            objectTypeIds: [objectTypeId],
            projectId: runtime.projectId,
          })
        }

        return storage.listActive({
          ...input,
          objectTypeIds: [...authority.context.grants["view:object"]].filter(
            (objectTypeId) => clearance?.unreadableType(objectTypeId) === undefined
          ),
          projectId: runtime.projectId,
        })
      },
    },
  }
}
