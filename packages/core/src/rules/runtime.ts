import type { RuleDefinition } from "./types"

export interface RulesRuntime {
  list(): readonly RuleDefinition[]
  getById(ruleId: string): RuleDefinition | null
}

export function createRulesRuntime(definitions: readonly RuleDefinition[]): RulesRuntime {
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
  return {
    list: () => [...definitionsById.values()],
    getById: (ruleId) => definitionsById.get(ruleId) ?? null,
  }
}
