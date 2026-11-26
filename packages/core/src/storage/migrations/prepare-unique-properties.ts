import { UniqueValueViolationError } from "../../materialization/errors"
import type { OntologyDefinitionCatalog } from "../../ontology/registry"
import type { TypeShapeChange } from "../../ontology/type-shapes"
import {
  UNIQUE_VALUE_KEY_VERSION,
  type UniquePropertyDefinition,
  uniquePropertiesOf,
  uniqueValueKey,
} from "../../ontology/unique-values"
import { isStorageSerializationFailure } from "../errors"
import type { PreparedUniqueProperty, UniqueValueEntry } from "../ontology/unique-values"
import type { Storage } from "../types"

/** Objects read, and values inserted, per round of a property's backfill. */
const BACKFILL_PAGE_ROWS = 1_000

/** A write committing during a backfill makes it fail serialization: start it over. */
const MAX_PREPARATION_ATTEMPTS = 5
const FIRST_RETRY_DELAY_MS = 50

interface DeclaredUniqueProperty extends UniquePropertyDefinition {
  readonly objectTypeId: string
}

/** A rename a migration run is about to apply: its values are still stored under `from`. */
export interface PendingUniqueRename {
  readonly objectTypeId: string
  readonly from: string
  readonly to: string
  /**
   * Whether the recorded shape has `from` unique: only then did the release writing it keep its
   * prepared values current. Others may be a failed deploy's, written past since: see
   * {@link madeUnique}.
   */
  readonly fromUnique: boolean
}

/**
 * Whether the run moves `from`'s unique values to `to` as they are: they were prepared with the
 * keys `to`'s values compare by, and kept current. Otherwise they are dropped, and `to`'s built
 * after the run, once a dry run under `from` found no duplicate.
 */
export function uniqueValuesMove(
  prepared: readonly PreparedUniqueProperty[],
  rename: PendingUniqueRename,
  kind: UniquePropertyDefinition["kind"] | undefined
): boolean {
  const from = prepared.find(
    (candidate) =>
      candidate.objectTypeId === rename.objectTypeId && candidate.propertyId === rename.from
  )
  return rename.fromUnique && kind !== undefined && from !== undefined && isCurrent(from, { kind })
}

/**
 * Brings the stored unique values in line with the ontology: builds those of a property that is
 * newly unique (or whose keys changed kind or version) from the objects already stored, and drops
 * those of a property that is no longer unique. Object writes keep them current from then on, and
 * refuse to claim a value of a property this has not prepared.
 *
 * Each property is prepared in its own serializable transaction, which first takes the provider's
 * preparation lock. Two objects already sharing a value fail the preparation, naming both, and
 * leave the property unprepared.
 */
export async function prepareUniqueProperties(input: {
  readonly storage: Storage
  readonly projectId: string
  readonly ontology: OntologyDefinitionCatalog
  /** Types whose stored values stay as they are, such as those whose data the code doesn't fit. */
  readonly keepObjectTypeIds?: ReadonlySet<string>
  /** Properties whose prepared values are rebuilt even when current: see {@link madeUnique}. */
  readonly rebuild?: readonly UniquePropertyRef[]
}): Promise<void> {
  const { storage, projectId } = input
  const rebuild = new Set((input.rebuild ?? []).map(propertyKey))
  const kept = (property: { readonly objectTypeId: string }) =>
    input.keepObjectTypeIds?.has(property.objectTypeId) ?? false
  const declared = declaredUniqueProperties(input.ontology).filter((property) => !kept(property))
  const declaredKeys = new Set(declared.map(propertyKey))

  for (const property of declared) {
    await withRetries(property, () =>
      storage.transaction(
        (tx) =>
          backfillProperty(tx, projectId, property, {
            announce: true,
            rebuild: rebuild.has(propertyKey(property)),
          }),
        { isolation: "serializable" }
      )
    )
  }

  const undeclared = (await storage.ontology.uniqueValues.listPrepared({ projectId })).filter(
    (property) => !declaredKeys.has(propertyKey(property)) && !kept(property)
  )
  await clearUniqueProperties({ storage, projectId, properties: undeclared })
}

/** Drops the values of each property, and its preparation, each in its own transaction. */
export async function clearUniqueProperties(input: {
  readonly storage: Storage
  readonly projectId: string
  readonly properties: readonly UniquePropertyRef[]
}): Promise<void> {
  const { storage, projectId } = input

  for (const { objectTypeId, propertyId } of input.properties) {
    await withRetries({ objectTypeId, propertyId }, () =>
      storage.transaction(
        async (tx) => {
          await tx.ontology.uniqueValues.lockPreparation({ projectId })
          await tx.ontology.uniqueValues.clear({ projectId, objectTypeId, propertyId })
        },
        { isolation: "serializable" }
      )
    )
  }
}

/** What a dry run throws to roll its values back. */
class DryRunRollback extends Error {}

/**
 * The duplicates {@link prepareUniqueProperties} would find, found without writing anything: each
 * property it would build is built in a transaction that always rolls back. A deploy runs this
 * while the old release can still start again, and prepares for real once nothing else can fail:
 * a preparation left behind by a failed deploy would be trusted, stale, by the next one.
 *
 * A rename about to run is read under its `from`, where the objects still hold the values, unless
 * the run moves them as they are.
 */
export async function checkUniqueProperties(input: UniqueDryRunInput): Promise<void> {
  const [duplicate] = await findUniqueDuplicates(input)
  if (duplicate) throw preparationError(duplicate, duplicate.violation)
}

export interface UniqueDryRunInput {
  readonly storage: Storage
  readonly projectId: string
  readonly ontology: OntologyDefinitionCatalog
  readonly keepObjectTypeIds?: ReadonlySet<string>
  readonly rebuild?: readonly UniquePropertyRef[]
  readonly renames?: readonly PendingUniqueRename[]
}

/** Two objects sharing a value of a property the code makes unique. */
export interface UniqueDuplicate {
  readonly objectTypeId: string
  readonly propertyId: string
  readonly violation: UniqueValueViolationError
}

/**
 * The dry run of {@link checkUniqueProperties}, each property's first duplicate collected instead
 * of thrown: the gate words them as findings when asked (`checkTypeShapes`' `uniqueDuplicates`).
 */
export async function findUniqueDuplicates(
  input: UniqueDryRunInput
): Promise<readonly UniqueDuplicate[]> {
  const { storage, projectId } = input
  const rebuild = new Set((input.rebuild ?? []).map(propertyKey))
  const declared = declaredUniqueProperties(input.ontology).filter(
    (property) => !(input.keepObjectTypeIds?.has(property.objectTypeId) ?? false)
  )
  const prepared = await storage.ontology.uniqueValues.listPrepared({ projectId })
  const duplicates: UniqueDuplicate[] = []

  for (const property of declared) {
    const rename = input.renames?.find(
      (candidate) =>
        candidate.objectTypeId === property.objectTypeId && candidate.to === property.propertyId
    )
    if (rename && uniqueValuesMove(prepared, rename, property.kind)) continue

    const storedKey = rename?.from ?? property.propertyId
    const checked = withRetries(property, () =>
      storage.transaction(
        async (tx) => {
          await backfillProperty(tx, projectId, property, {
            announce: false,
            rebuild: rebuild.has(propertyKey(property)),
            storedKey,
          })
          throw new DryRunRollback()
        },
        { isolation: "serializable" }
      )
    )
    await checked.catch((error: unknown) => {
      if (error instanceof DryRunRollback) return

      const violation = error instanceof Error ? error.cause : undefined
      if (!(violation instanceof UniqueValueViolationError)) throw error
      duplicates.push({ ...property, violation })
    })
  }

  return duplicates
}

interface UniquePropertyRef {
  readonly objectTypeId: string
  readonly propertyId: string
}

/**
 * The properties a deploy makes unique, from the recorded shape to the code's: their prepared
 * values are never trusted. A failed deploy may have built them, and the old release, started
 * again, writes such a property without keeping them: it may have written a value another object
 * holds since.
 */
export function madeUnique(
  types: readonly { readonly objectTypeId: string; readonly changes: readonly TypeShapeChange[] }[]
): UniquePropertyRef[] {
  return types.flatMap(({ objectTypeId, changes }) =>
    changes.flatMap((change) =>
      change.kind === "property-unique" && change.unique
        ? [{ objectTypeId, propertyId: change.propertyId }]
        : []
    )
  )
}

function declaredUniqueProperties(ontology: OntologyDefinitionCatalog): DeclaredUniqueProperty[] {
  const valueTypesById = ontology.getValueTypesById()
  return ontology.listObjectTypes().flatMap((objectType) =>
    uniquePropertiesOf(objectType, valueTypesById).map((property) => ({
      objectTypeId: objectType.id,
      ...property,
    }))
  )
}

async function withRetries(
  property: { readonly objectTypeId: string; readonly propertyId: string },
  run: () => Promise<void>
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (!isStorageSerializationFailure(error) || attempt >= MAX_PREPARATION_ATTEMPTS) {
        throw preparationError(property, error)
      }
      await new Promise((resolve) => setTimeout(resolve, FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1)))
    }
  }
}

/**
 * `announce`: say when values are built, which a dry run doesn't. `rebuild`: build them even when
 * the prepared ones look current. `storedKey`: where the objects hold the values, the old id of a
 * rename's dry run, which is always built again.
 */
async function backfillProperty(
  tx: Storage,
  projectId: string,
  property: DeclaredUniqueProperty,
  options: { readonly announce: boolean; readonly rebuild: boolean; readonly storedKey?: string }
): Promise<void> {
  const { objectTypeId, propertyId } = property
  const storedKey = options.storedKey ?? propertyId
  const values = tx.ontology.uniqueValues
  await values.lockPreparation({ projectId })

  const current = (await values.listPrepared({ projectId })).find(
    (prepared) => propertyKey(prepared) === propertyKey(property)
  )
  const rebuilt = options.rebuild || storedKey !== propertyId
  if (current && isCurrent(current, property) && !rebuilt) return

  await values.clear({ projectId, objectTypeId, propertyId })

  let afterPrimaryId: string | undefined
  do {
    const page = await tx.objects.listByPrimaryIdPage({
      projectId,
      objectTypeId,
      limit: BACKFILL_PAGE_ROWS,
      ...(afterPrimaryId === undefined ? {} : { afterPrimaryId }),
    })
    if (options.announce && afterPrimaryId === undefined && page.objects.length > 0) {
      console.info(`[Sixb] Preparing unique property '${objectTypeId}.${propertyId}'.`)
    }

    const entries: UniqueValueEntry[] = []
    for (const object of page.objects) {
      const valueKey = uniqueValueKey(property.kind, object.properties[storedKey])
      if (valueKey !== null) entries.push({ valueKey, primaryId: object.primaryId })
    }
    if (entries.length > 0) await values.insert({ projectId, objectTypeId, propertyId, entries })

    afterPrimaryId = page.nextPrimaryId
  } while (afterPrimaryId !== undefined)

  await values.markPrepared({
    projectId,
    objectTypeId,
    propertyId,
    keyKind: property.kind,
    keyVersion: UNIQUE_VALUE_KEY_VERSION,
    preparedAt: new Date().toISOString(),
  })
}

/** Keys are rebuilt when they were computed for another kind, as after a schema change. */
function isCurrent(
  prepared: PreparedUniqueProperty,
  property: Pick<UniquePropertyDefinition, "kind">
): boolean {
  return prepared.keyKind === property.kind && prepared.keyVersion === UNIQUE_VALUE_KEY_VERSION
}

function preparationError(
  property: { readonly objectTypeId: string; readonly propertyId: string },
  error: unknown
): unknown {
  if (!(error instanceof UniqueValueViolationError)) return error
  return new Error(
    `[Sixb] Cannot make '${property.objectTypeId}.${property.propertyId}' unique: objects ` +
      `'${error.holderPrimaryId}' and '${error.claimantPrimaryId}' share a value. ` +
      "Fix the data, then start again.",
    { cause: error }
  )
}

function propertyKey(property: { readonly objectTypeId: string; readonly propertyId: string }) {
  return JSON.stringify([property.objectTypeId, property.propertyId])
}
