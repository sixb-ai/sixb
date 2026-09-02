import { toolsFromProjectConfig } from "./tool-definition"
import type { AgentToolDefinition } from "./types"

/** Immutable catalog of project tools registered with a Sixb host. */
export interface AgentToolCatalog {
  list(): readonly AgentToolDefinition[]
  getByName(name: string): AgentToolDefinition | null
}

/** Validate, normalize, and index the tools supplied through `createSixb({ tools })`. */
export function createAgentToolCatalog(
  definitions: readonly AgentToolDefinition[] | undefined
): AgentToolCatalog {
  const tools = toolsFromProjectConfig(definitions)
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))

  return Object.freeze({
    list: () => tools,
    getByName: (name: string) => toolsByName.get(name) ?? null,
  })
}
