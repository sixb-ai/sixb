/**
 * The objects that hold an artifact, as one caller reads them.
 *
 * The holder index (`ObjectStorage.listArtifactHolders`) is unscoped, and nothing rewrites it when
 * the ontology changes, so a row is never trusted as it is: each holder is read again through the
 * caller's object reader, as a file an object holds is opened. The object must be one they read,
 * the property one they are cleared for, and its value must still hold the artifact. Whoever may
 * also edit the object's type may update the artifact.
 */
import { isRuntimeAllowed } from "../authorization"
import { AuthorizationError } from "../authorization/errors"
import type { AuthorizedObjectReader } from "../execution/authorized-object-reader"
import { collectArtifactRefIds } from "../ontology/artifact-ref"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ObjectRow, ObjectStorage } from "../storage"
import { objectBatchKey } from "../storage/objects/keys"
import type { ArtifactHolder } from "../storage/ontology"

/** One object property that holds the artifact, as the caller reads it. */
export interface ArtifactHolding extends ArtifactHolder {
  /** `update` when the caller may edit the object's type, `read` otherwise. */
  readonly access: "update" | "read"
  /** The object, as the caller reads it. */
  readonly object: ObjectRow
}

/** How many index rows each read takes: an artifact is rarely held by more objects than this. */
const HOLDER_PAGE = 100

/**
 * The holdings of the artifact that the caller reads, in the index's order. Each page of holders
 * is read with one object read per type; stop iterating to stop reading.
 */
export async function* readableHoldings(input: {
  readonly runtime: SixbRuntimeContext
  /** The caller's reader, reading from the same storage as `objects`. */
  readonly reader: AuthorizedObjectReader
  readonly objects: Pick<ObjectStorage, "listArtifactHolders">
  readonly artifactId: string
}): AsyncGenerator<ArtifactHolding> {
  const { runtime, reader, artifactId } = input
  let after: ArtifactHolder | undefined

  do {
    const page = await input.objects.listArtifactHolders({
      projectId: runtime.projectId,
      artifactId,
      ...(after ? { after } : {}),
      limit: HOLDER_PAGE,
    })

    const objects = await readHolders(reader, page.holders)
    for (const holder of page.holders) {
      const object = objects.get(objectBatchKey(holder.objectTypeId, holder.primaryId))
      if (!object || !holdsArtifact(runtime, object, holder.propertyId, artifactId)) continue

      const edits = isRuntimeAllowed(runtime, {
        kind: "object.edit",
        objectTypeId: holder.objectTypeId,
      })
      yield { ...holder, access: edits ? "update" : "read", object }
    }

    after = page.next
  } while (after)
}

/**
 * The holders' objects the caller reads, keyed by `objectBatchKey`. A type they cannot view reads
 * nothing, and an object their view condition hides is absent.
 */
async function readHolders(
  reader: AuthorizedObjectReader,
  holders: readonly ArtifactHolder[]
): Promise<ReadonlyMap<string, ObjectRow>> {
  // An object that holds the artifact under several properties is read once.
  const byType = new Map<string, Set<string>>()
  for (const { objectTypeId, primaryId } of holders) {
    const primaryIds = byType.get(objectTypeId) ?? new Set()
    byType.set(objectTypeId, primaryIds.add(primaryId))
  }

  const read = new Map<string, ObjectRow>()
  for (const [objectTypeId, primaryIds] of byType) {
    try {
      const rows = await reader.getByPrimaryIdBatch({
        items: [...primaryIds].map((primaryId) => ({ objectTypeId, primaryId })),
      })
      for (const [key, row] of rows) read.set(key, row)
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error
    }
  }

  return read
}

/**
 * Whether the property, as the caller reads it, still holds the artifact. One the caller is not
 * cleared for comes back without its value, and one the type no longer declares holds nothing.
 */
function holdsArtifact(
  runtime: SixbRuntimeContext,
  object: ObjectRow,
  propertyId: string,
  artifactId: string
): boolean {
  const property = runtime.ontology
    .getObjectTypeById(object.objectTypeId)
    ?.properties.find((candidate) => candidate.id === propertyId)
  if (!property) return false

  const held = collectArtifactRefIds(
    property.schema,
    object.properties[propertyId],
    runtime.ontology.getValueTypesById(),
    new Set()
  )
  return held.has(artifactId)
}
