import { UniqueValueViolationError } from "../../materialization/errors"
import type { OntologyDefinitionCatalog } from "../../ontology/registry"
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
}): Promise<void> {
  const { storage, projectId } = input
  const declared = declaredUniqueProperties(input.ontology)
  const declaredKeys = new Set(declared.map(propertyKey))

  for (const property of declared) {
    await withRetries(property, () =>
      storage.transaction((tx) => backfillProperty(tx, projectId, property), {
        isolation: "serializable",
      })
    )
  }

  const undeclared = (await storage.ontology.uniqueValues.listPrepared({ projectId })).filter(
    (property) => !declaredKeys.has(propertyKey(property))
  )
  for (const { objectTypeId, propertyId } of undeclared) {
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

async function backfillProperty(
  tx: Storage,
  projectId: string,
  property: DeclaredUniqueProperty
): Promise<void> {
  const { objectTypeId, propertyId } = property
  const values = tx.ontology.uniqueValues
  await values.lockPreparation({ projectId })

  const current = (await values.listPrepared({ projectId })).find(
    (prepared) => propertyKey(prepared) === propertyKey(property)
  )
  if (current && isCurrent(current, property)) return

  await values.clear({ projectId, objectTypeId, propertyId })

  let afterPrimaryId: string | undefined
  do {
    const page = await tx.objects.listByPrimaryIdPage({
      projectId,
      objectTypeId,
      limit: BACKFILL_PAGE_ROWS,
      ...(afterPrimaryId === undefined ? {} : { afterPrimaryId }),
    })
    if (afterPrimaryId === undefined && page.objects.length > 0) {
      console.info(`[Sixb] Preparing unique property '${objectTypeId}.${propertyId}'.`)
    }

    const entries: UniqueValueEntry[] = []
    for (const object of page.objects) {
      const valueKey = uniqueValueKey(property.kind, object.properties[propertyId])
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
function isCurrent(prepared: PreparedUniqueProperty, property: DeclaredUniqueProperty): boolean {
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
