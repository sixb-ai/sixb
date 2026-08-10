import type { SixbRuntimeContext } from "../runtime/types"
import { SyncValidationError } from "./errors"
import { type RequestSyncRunInput, requestSyncRun, type SyncRunRequestResult } from "./request"
import type { SyncDefinition } from "./types"

export interface SyncsRuntime {
  list(): readonly SyncDefinition[]
  getById(syncId: string): SyncDefinition | null
  request(input: RequestSyncRunInput): Promise<SyncRunRequestResult>
}

export function createSyncsRuntime(
  runtime: SixbRuntimeContext,
  definitions: readonly SyncDefinition[]
): SyncsRuntime {
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
  return {
    list: () => [...definitionsById.values()],
    getById: (syncId) => definitionsById.get(syncId) ?? null,
    request: async (input) => {
      const sync = definitionsById.get(input.syncId)
      if (!sync) throw new SyncValidationError(`[Sixb] Unknown sync '${input.syncId}'`)
      return requestSyncRun(runtime, sync, input)
    },
  }
}
