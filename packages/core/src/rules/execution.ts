import { isAllowed } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ListActiveRuleStatesInput, ListActiveRuleStatesResult } from "../storage/rules"
import type { RulesRuntime } from "./runtime"
import type { RuleDefinition } from "./types"

export interface ExecutionRuleStatesRuntime {
  list(
    input?: Omit<ListActiveRuleStatesInput, "projectId" | "objectTypeIds">
  ): Promise<ListActiveRuleStatesResult>
}

export interface ExecutionRulesRuntime {
  list(): readonly RuleDefinition[]
  getById(ruleId: string): RuleDefinition | null
  readonly states: ExecutionRuleStatesRuntime
}

export function createExecutionRulesRuntime(
  runtime: SixbRuntimeContext,
  source: RulesRuntime
): ExecutionRulesRuntime {
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
