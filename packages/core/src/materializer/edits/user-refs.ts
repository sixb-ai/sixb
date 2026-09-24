/**
 * Existence checks for `userRef` values written by managed edits.
 *
 * Auth storage is read once per commit, before the serializable transaction opens: every user id
 * the operations carry is looked up, deduplicated, and the statuses travel into the synchronous
 * edit pass. There, an operation may only introduce a user that exists and is active. A value the
 * object already held is never re-checked, so suspending a user leaves the objects that reference
 * them writable. Users are never deleted, so a check at write time stays true for existence.
 */
import type { JsonValue } from "../../json"
import { MaterializationValidationError } from "../../materialization/errors"
import type { OntologyEditOperation } from "../../materialization/model"
import type { OntologyRegistry } from "../../ontology"
import { collectUserRefIds, userReferenceProblem } from "../../ontology/user-ref"
import type { UserStatus } from "../../storage/auth/types"
import type { MaterializerContext } from "../context"

/** Statuses of the users a commit's operations reference; `null` marks an unknown id. */
export type ReferencedUsers =
  | { readonly kind: "loaded"; readonly statuses: ReadonlyMap<string, UserStatus | null> }
  | { readonly kind: "unavailable" }

const NO_REFERENCED_USERS: ReferencedUsers = { kind: "loaded", statuses: new Map() }

export async function loadReferencedUsers(
  context: Pick<MaterializerContext, "projectId" | "ontology" | "storage">,
  operations: readonly OntologyEditOperation[]
): Promise<ReferencedUsers> {
  const ids = new Set<string>()
  for (const operation of operations) {
    switch (operation.kind) {
      case "object.create":
      case "object.upsert":
        collectObjectUserRefIds(
          context.ontology,
          operation.ref.objectTypeId,
          operation.properties,
          ids
        )
        break
      case "object.patch":
        collectObjectUserRefIds(context.ontology, operation.ref.objectTypeId, operation.set, ids)
        break
      default:
        break
    }
  }
  if (ids.size === 0) return NO_REFERENCED_USERS

  const users = context.storage.auth?.users
  if (!users) return { kind: "unavailable" }
  const entries = await Promise.all(
    [...ids].map(async (id) => {
      const user = await users.getById({ projectId: context.projectId, id })
      return [id, user?.status ?? null] as const
    })
  )
  return { kind: "loaded", statuses: new Map(entries) }
}

/**
 * Reject user references an object operation introduces unless the user exists and is active.
 *
 * `before` is the effective object the operation started from; ids it already held under the same
 * property are accepted as they are.
 */
export function assertIntroducedUsersActive(
  ontology: OntologyRegistry,
  objectTypeId: string,
  before: Readonly<Record<string, JsonValue>> | undefined,
  after: Readonly<Record<string, JsonValue>>,
  users: ReferencedUsers
): void {
  const objectType = ontology.resolveObjectType(objectTypeId)
  const valueTypesById = ontology.getValueTypesById()
  for (const property of objectType.properties) {
    const introduced = collectUserRefIds(
      property.schema,
      after[property.id],
      valueTypesById,
      new Set()
    )
    if (introduced.size === 0) continue
    const held = collectUserRefIds(
      property.schema,
      before?.[property.id],
      valueTypesById,
      new Set()
    )
    for (const id of introduced) {
      if (held.has(id)) continue
      const problem = userReferenceProblem(
        `Property '${objectTypeId}.${property.id}'`,
        id,
        users.kind === "unavailable" ? "unverifiable" : (users.statuses.get(id) ?? null)
      )
      if (problem) throw new MaterializationValidationError(problem)
    }
  }
}

function collectObjectUserRefIds(
  ontology: OntologyRegistry,
  objectTypeId: string,
  properties: Readonly<Record<string, JsonValue>>,
  into: Set<string>
): void {
  // Unknown types and properties are rejected by the edit pass; nothing to look up for them.
  const objectType = ontology.getObjectTypeById(objectTypeId)
  if (!objectType) return
  const valueTypesById = ontology.getValueTypesById()
  for (const property of objectType.properties) {
    collectUserRefIds(property.schema, properties[property.id], valueTypesById, into)
  }
}
