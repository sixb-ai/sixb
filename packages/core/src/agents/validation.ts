import type { GroupDefinition, SecurityRegistry } from "../security"
import { AgentDefinitionError } from "./errors"
import type { AgentDefinition, AgentLoopConfig } from "./types"

export function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new AgentDefinitionError(`[Sixb] Agent ${field} must not be empty.`)
  }
}

export function isAgentDefinition(value: unknown): value is AgentDefinition {
  return (
    isRecord(value) &&
    value.kind === "agent" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.instructions === "string" &&
    Array.isArray(value.groupIds)
  )
}

export function assertValidLoopConfig(loop: AgentLoopConfig | undefined): void {
  const maxSteps = loop?.stopWhen?.maxSteps
  if (maxSteps === undefined) {
    return
  }
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new AgentDefinitionError(
      "[Sixb] Agent loop.stopWhen.maxSteps must be a positive finite integer."
    )
  }
}

export function groupIdsFromDefinitions(
  agentId: string,
  groups: readonly GroupDefinition[] | undefined
): readonly string[] {
  const groupIds = (groups ?? []).map((group) => {
    if (!isRecord(group) || group.kind !== "group") {
      throw new AgentDefinitionError(
        `[Sixb] Agent '${agentId}' groups must contain only group definitions.`
      )
    }

    assertNonEmpty(group.id, `Agent '${agentId}' group id`)
    return group.id
  })

  assertNoDuplicateGroupIds(agentId, groupIds)
  return groupIds
}

export function validateAgentGroupReferences(
  agents: readonly AgentDefinition[],
  security: SecurityRegistry
): void {
  for (const agent of agents) {
    assertNoDuplicateGroupIds(agent.id, agent.groupIds)
    for (const groupId of agent.groupIds) {
      if (!security.getGroupById(groupId)) {
        throw new AgentDefinitionError(
          `[Sixb] Agent '${agent.id}' groups references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
        )
      }
    }
  }
}

function assertNoDuplicateGroupIds(agentId: string, groupIds: readonly string[]): void {
  const seen = new Set<string>()
  for (const groupId of groupIds) {
    assertNonEmpty(groupId, `Agent '${agentId}' group id`)
    if (seen.has(groupId)) {
      throw new AgentDefinitionError(
        `[Sixb] Agent '${agentId}' groups contains duplicate group id '${groupId}'.`
      )
    }
    seen.add(groupId)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
