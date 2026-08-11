import type { SyncDefinition } from "./types"

export interface SyncsRuntime {
  list(): readonly SyncDefinition[]
  getById(syncId: string): SyncDefinition | null
}

export function createSyncsRuntime(definitions: readonly SyncDefinition[]): SyncsRuntime {
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
  return {
    list: () => [...definitionsById.values()],
    getById: (syncId) => definitionsById.get(syncId) ?? null,
  }
}
