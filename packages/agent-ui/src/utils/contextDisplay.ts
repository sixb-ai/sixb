import { type AgentContextInput, agentContextIdentity } from "@sixb/core/agents/context"

export function agentContextLabel(context: AgentContextInput): string {
  if (context.kind === "app-state") return context.label

  const typeLabel = displayWords(context.ref.objectTypeId)
  const primaryId = stripObjectTypePrefix(context.ref.primaryId, context.ref.objectTypeId)
  const parts = primaryId.split(/[:/]+/).filter(Boolean)
  while (parts.length > 1 && looksOpaque(parts.at(-1) ?? "")) parts.pop()

  const subject =
    parts.length === 1 && looksOpaque(parts[0] ?? "")
      ? `${parts[0]?.slice(0, 8)}…`
      : displayWords(parts.join(" "))
  if (!subject) return typeLabel
  return `${typeLabel} · ${subject}`
}

function stripObjectTypePrefix(primaryId: string, objectTypeId: string): string {
  const words = splitWords(objectTypeId)
  const prefixes = new Set([objectTypeId, words.join("-"), words.join("_"), words.join(" ")])
  const lowerPrimaryId = primaryId.toLowerCase()

  for (const prefix of prefixes) {
    for (const separator of [":", "/", "-", "_"]) {
      const candidate = `${prefix.toLowerCase()}${separator}`
      if (lowerPrimaryId.startsWith(candidate)) return primaryId.slice(candidate.length)
    }
  }
  return primaryId
}

function displayWords(value: string): string {
  const words = splitWords(value)
  if (words.length === 0) return "Context"
  const label = words.join(" ")
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s:_/-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

function looksOpaque(value: string): boolean {
  return (
    /^[a-f\d]{16,}$/i.test(value) ||
    /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value) ||
    (/^[a-z\d]+$/i.test(value) && value.length >= 24)
  )
}

export function mergeAgentContext(
  primary: readonly AgentContextInput[],
  secondary: readonly AgentContextInput[]
): readonly AgentContextInput[] {
  const values = new Map(primary.map((context) => [agentContextIdentity(context), context]))
  for (const context of secondary) {
    const identity = agentContextIdentity(context)
    if (!values.has(identity)) values.set(identity, context)
  }
  return [...values.values()]
}
