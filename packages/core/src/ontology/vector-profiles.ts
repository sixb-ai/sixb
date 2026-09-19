import type { ObjectVectorSearchProfile } from "./types"

/** Metadata-only copy. Executable provider objects and credentials never leave the host. */
export function snapshotVectorProfiles(
  profiles: Readonly<Record<string, ObjectVectorSearchProfile>>
): Readonly<Record<string, ObjectVectorSearchProfile>> {
  const snapshot: Record<string, ObjectVectorSearchProfile> = Object.create(null)
  for (const [name, profileDefinition] of Object.entries(profiles)) {
    const { providerId, modelId, definition } = profileDefinition.model
    snapshot[name] = Object.freeze({
      source: Object.freeze([...profileDefinition.source]),
      model: Object.freeze({
        providerId,
        modelId,
        definition: Object.freeze({
          kind: "embedding" as const,
          providerId,
          modelId,
          dimensions: definition.dimensions,
        }),
      }),
    })
  }
  return Object.freeze(snapshot)
}
