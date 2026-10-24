/**
 * Writes by a principal that views a type only through a condition.
 *
 * Such a writer acts on the objects its reader shows it, and on nothing else. Each existing object
 * a write names is read through that reader first: one it cannot find is hidden or missing, and
 * the write treats both as missing. Its commit then expects each object as the reader saw it, so
 * one hidden meanwhile is never written.
 *
 * Nothing is checked after the write: a writer may create an object it then cannot see.
 */
import { assertAuthorized, assertCanEdit } from "../authorization"
import type { JsonValue } from "../json"
import type {
  ExpectedObjectRevision,
  OntologyEditOperation,
  OntologyObjectRef,
} from "../materialization/model"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ObjectRow } from "../storage"
import {
  expectedRevision,
  objectCreateOperation,
  objectUpsertOperation,
} from "./materializer-adapter"
import { primaryIdTakenError } from "./unique-violation"

type AuthorizeContext = Pick<
  SixbRuntimeContext,
  "projectId" | "runtimeAuthorization" | "authorization" | "objectReader"
>
type WriteContext = AuthorizeContext & Pick<SixbRuntimeContext, "storage">

/** What the writer finds at an id: the object it sees, or one it cannot see. Nothing when free. */
export type FoundObject = ObjectRow | "hidden"

/**
 * `can.edit` on a type, and a view of it: whole, or through a condition. The reader then applies
 * that condition to each object the write names.
 */
export async function assertCanEditType(
  ctx: AuthorizeContext,
  objectTypeId: string
): Promise<void> {
  if (!ctx.objectReader.viewsThroughCondition(objectTypeId)) {
    assertCanEdit(ctx, objectTypeId)
    return
  }

  assertAuthorized(ctx, { kind: "object.edit", objectTypeId })
  await ctx.objectReader.assertViewable([objectTypeId])
}

/**
 * What a writer that views `objectTypeId` through a condition finds at each primary id it writes.
 *
 * The ids its reader does not show are looked up in the object storage, to tell a free id from one
 * a hidden object holds. That tells the writer no more than that the id is taken.
 */
export async function findWrittenObjects(
  ctx: WriteContext,
  objectTypeId: string,
  primaryIds: readonly string[]
): Promise<ReadonlyMap<string, FoundObject>> {
  const ids = [...new Set(primaryIds)]
  const found = new Map<string, FoundObject>()
  if (ids.length === 0) return found

  const visible = await ctx.objectReader.getByPrimaryIdBatch({
    items: ids.map((primaryId) => ({ objectTypeId, primaryId })),
  })
  for (const row of visible.values()) found.set(row.primaryId, row)

  const unseen = ids.filter((primaryId) => !found.has(primaryId))
  if (unseen.length === 0) return found

  const stored = await ctx.storage.objects.getByPrimaryIdBatch({
    projectId: ctx.projectId,
    items: unseen.map((primaryId) => ({ objectTypeId, primaryId })),
  })
  for (const row of stored.values()) found.set(row.primaryId, "hidden")

  return found
}

/**
 * Write one object as the writer found it: update the object it sees, and create one where the id
 * is free. A create fails in its commit if any object, a deleted one included, holds the id by
 * then, so it never merges into an object the writer did not see. An id a hidden object holds is
 * taken.
 */
export function writeFoundObject(input: {
  readonly id: string
  readonly ref: OntologyObjectRef
  readonly properties: Readonly<Record<string, JsonValue>>
  readonly primaryPropertyId: string
  readonly found: FoundObject | undefined
}): OntologyEditOperation {
  const { found, primaryPropertyId, ...write } = input

  if (found === "hidden") throw primaryIdTakenError(write.ref.objectTypeId, primaryPropertyId)
  if (found === undefined) return objectCreateOperation(write)

  return objectUpsertOperation(write)
}

/** The revisions a commit expects of the objects its writer saw. */
export function expectSeen(found: Iterable<FoundObject>): ExpectedObjectRevision[] {
  return [...found].flatMap((object) => (object === "hidden" ? [] : [expectedRevision(object)]))
}
