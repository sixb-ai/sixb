import { isRuntimeAllowed } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
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
  const visible = (rule: RuleDefinition) => {
    if (authority.type === "denied" || authority.type === "delegated") return false
    return isRuntimeAllowed(runtime, {
      kind: "object.view",
      objectTypeId: rule.subject.objectTypeId,
    })
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
      list: (input = {}) => {
        if (authority.type === "denied" || authority.type === "delegated") {
          return Promise.resolve({ states: [], hasMore: false, total: 0 })
        }
        const storage = runtime.storage.rules
        if (!storage) return Promise.resolve({ states: [], hasMore: false, total: 0 })
        return storage.listActive({
          ...input,
          objectTypeIds:
            authority.type === "principal"
              ? [...authority.context.grants["view:object"]]
              : undefined,
          projectId: runtime.projectId,
        })
      },
    },
  }
}
