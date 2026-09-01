import type { SixbRuntimeContext } from "../runtime/types"
import {
  type AgentContextEntryInput,
  type AgentContextPart,
  normalizeAgentContextEntries,
} from "./context"
import { AgentRequestError } from "./errors"

/** Resolve the exact context parts that will be persisted with the triggering user message. */
export async function resolveAgentContextParts(
  runtime: SixbRuntimeContext,
  input: readonly AgentContextEntryInput[] | undefined
): Promise<readonly AgentContextPart[]> {
  const entries = normalizeAgentContextEntries(input)

  for (const entry of entries) {
    if (entry.context.kind !== "object") continue
    const { objectTypeId, primaryId } = entry.context.ref

    try {
      runtime.ontology.resolveObjectType(objectTypeId)
    } catch {
      invalidContext(`context references an unknown object type '${objectTypeId}'`)
    }

    const object = await runtime.objectReader.getByPrimaryId({
      objectTypeId,
      primaryId,
    })
    if (!object) {
      invalidContext(`context references an unknown object '${objectTypeId}:${primaryId}'`)
    }
  }

  return entries.map((entry) => ({ type: "context", ...entry }))
}

function invalidContext(message: string): never {
  throw new AgentRequestError("invalid_context", `[Sixb] Invalid agent context: ${message}.`)
}
