import type { SchemaOrRef, ValueType } from "../../ontology"
import { artifactReferenceProblem, collectArtifactRefIds } from "../../ontology/artifact-ref"
import { isObjectRefSchema } from "../../ontology/refs"

/**
 * Reject params that reference an artifact their requester may not change. One that does not exist
 * gets the same error, so a request never tells them apart.
 *
 * Callers run it only when a new run is created: replaying an existing run keeps the params it was
 * accepted with, even if an artifact they reference was deleted or unshared since.
 */
export async function assertParamArtifactsUpdatable(input: {
  /** The artifacts among these that the requester may change; a missing one is not among them. */
  readonly updatable: (artifactIds: ReadonlySet<string>) => Promise<ReadonlySet<string>>
  readonly schemas: Readonly<Record<string, SchemaOrRef>>
  readonly values: Readonly<Record<string, unknown>>
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  /** Names one param in error messages, for example `Action param 'meeting.attach.doc'`. */
  readonly describe: (paramId: string) => string
  readonly invalid: (message: string) => Error
}): Promise<void> {
  const references: { readonly paramId: string; readonly id: string }[] = []
  for (const [paramId, schema] of Object.entries(input.schemas)) {
    if (isObjectRefSchema(schema)) continue

    const ids = collectArtifactRefIds(
      schema,
      input.values[paramId],
      input.valueTypesById,
      new Set()
    )
    for (const id of ids) references.push({ paramId, id })
  }
  if (references.length === 0) return

  const updatable = await input.updatable(new Set(references.map((reference) => reference.id)))

  for (const { paramId, id } of references) {
    if (updatable.has(id)) continue
    throw input.invalid(artifactReferenceProblem(input.describe(paramId), id))
  }
}
