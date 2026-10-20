import type { UserExpansionPlan } from "../objects/query/user-expansions"
import type { OntologyRegistry } from "../ontology"
import { isUserRef, isUserRefPropertySchema } from "../ontology/user-ref"
import type {
  AuthUserStore,
  ExpandedLinkValue,
  ObjectRow,
  ObjectRowUsers,
  UserRecord,
} from "../storage"
import { toUserProfile } from "../users/execution"

/** Ids read per storage call: one call for a typical page, bounded for the largest. */
const LOOKUP_BATCH_SIZE = 500

/** One expanded property of one row, and the member ids its value holds, in stored order. */
interface UserSlot {
  readonly users: ObjectRowUsers
  readonly propertyId: string
  readonly many: boolean
  readonly ids: readonly string[]
}

/**
 * Attach the member profiles a query expands to the rows the reader returns.
 *
 * Every row whose type declares an expanded property gets `users`, so reading an entry never
 * throws. An entry is left out when the reader may not view the directory, and when the reader
 * cannot read the value: the rows have already lost their hidden values and carry `redactions`,
 * so a marked value is never looked up. The rows must be the reader's own copies.
 */
export async function attachUserProfiles(input: {
  readonly rows: readonly ObjectRow[]
  readonly plan: UserExpansionPlan
  readonly ontology: OntologyRegistry
  readonly projectId: string
  readonly canViewUsers: boolean
  readonly users: AuthUserStore | undefined
}): Promise<void> {
  const slots: UserSlot[] = []
  collectSlots(input.rows, input.plan, input.ontology, slots)

  if (!input.canViewUsers) return

  const records = await readUsers(input, slots)

  for (const slot of slots) {
    slot.users[slot.propertyId] = expandedValue(slot, records)
  }
}

// An array keeps its members in order and skips ids no member has; a single reference to no
// member, or an empty one, is `null`.
function expandedValue(slot: UserSlot, records: ReadonlyMap<string, UserRecord>) {
  const profiles = slot.ids.flatMap((id) => {
    const record = records.get(id)
    return record ? [toUserProfile(record)] : []
  })

  return slot.many ? profiles : (profiles[0] ?? null)
}

function collectSlots(
  rows: readonly ObjectRow[],
  plan: UserExpansionPlan,
  ontology: OntologyRegistry,
  into: UserSlot[]
): void {
  for (const row of rows) {
    const properties = ontology.getObjectTypeById(row.objectTypeId)?.properties ?? []

    for (const propertyId of plan.users) {
      const property = properties.find((candidate) => candidate.id === propertyId)
      if (!property || !isUserRefPropertySchema(property.schema)) continue

      row.users ??= {}
      if (row.redactions?.[propertyId]) continue

      into.push({
        users: row.users,
        propertyId,
        many: property.schema !== "userRef",
        ids: userIdsOf(row.properties[propertyId]),
      })
    }

    for (const link of plan.links) {
      collectSlots(linkedRows(row.links?.[link.linkId]), link.plan, ontology, into)
    }
  }
}

async function readUsers(
  input: { readonly projectId: string; readonly users: AuthUserStore | undefined },
  slots: readonly UserSlot[]
): Promise<ReadonlyMap<string, UserRecord>> {
  const records = new Map<string, UserRecord>()
  const ids = [...new Set(slots.flatMap((slot) => slot.ids))]
  if (!input.users || ids.length === 0) return records

  for (let start = 0; start < ids.length; start += LOOKUP_BATCH_SIZE) {
    const batch = ids.slice(start, start + LOOKUP_BATCH_SIZE)
    for (const record of await input.users.getByIds({ projectId: input.projectId, ids: batch })) {
      records.set(record.id, record)
    }
  }

  return records
}

// A single reference, or the references of an array in order. Anything else holds no member.
function userIdsOf(value: unknown): string[] {
  if (isUserRef(value)) return [value.id]
  if (!Array.isArray(value)) return []
  return value.filter(isUserRef).map((ref) => ref.id)
}

function linkedRows(value: ExpandedLinkValue | undefined): readonly ObjectRow[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value
  return [value as ObjectRow]
}
