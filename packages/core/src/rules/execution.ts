import { isAllowed } from "../authorization"
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
  const visible = (rule: RuleDefinition) =>
    isAllowed(runtime.authorization, {
      kind: "object.view",
      objectTypeId: rule.subject.objectTypeId,
    })

  return {
    list: () => source.list().filter(visible),
    getById: (ruleId) => {
      const rule = source.getById(ruleId)
      return rule && visible(rule) ? rule : null
    },
    states: {
      list: (input = {}) => {
        const storage = runtime.storage.rules
        if (!storage) return Promise.resolve({ states: [], hasMore: false, total: 0 })
        return storage.listActive({
          projectId: runtime.projectId,
          ...input,
          objectTypeIds: runtime.authorization
            ? [...runtime.authorization.grants["view:object"]]
            : undefined,
        })
      },
    },
  }
}
