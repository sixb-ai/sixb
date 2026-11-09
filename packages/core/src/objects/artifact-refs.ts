/**
 * Artifact references a principal writes.
 *
 * A writer gives an object only an artifact it may change itself: a reference never gives anyone
 * more than its writer has, and the object's editors may change what it holds. Which artifacts the
 * writer may change is decided here, by its artifact access rule, before the commit: the commit
 * then carries those it may not, and the Materializer refuses each one an object did not already
 * hold exactly as it refuses a missing artifact. Trusted code reaches every artifact, so only
 * existence applies to it.
 */
import { updatableArtifactIds } from "../artifacts/execution"
import type { JsonValue } from "../json"
import { collectArtifactRefIds } from "../ontology/artifact-ref"
import type { ResolvedObjectContext } from "./context"

/** The artifacts these writes of one object type name that their writer may not change. */
export async function unchangeableArtifactIds(
  ctx: ResolvedObjectContext,
  writes: readonly Readonly<Record<string, JsonValue>>[]
): Promise<readonly string[]> {
  const valueTypesById = ctx.ontology.getValueTypesById()
  const named = new Set<string>()
  for (const properties of writes) {
    for (const property of ctx.objectType.properties) {
      collectArtifactRefIds(property.schema, properties[property.id], valueTypesById, named)
    }
  }

  // Without artifact storage, the Materializer reports that it cannot verify them.
  if (named.size === 0 || !ctx.storage.artifacts) return []

  const updatable = await updatableArtifactIds(ctx, named)
  return [...named].filter((id) => !updatable.has(id))
}
