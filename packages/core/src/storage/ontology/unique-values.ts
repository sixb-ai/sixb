/**
 * The stored values of unique properties, outside the write path.
 *
 * Every object write keeps them current through its plan's unique value items. This capability
 * builds them for a property that becomes unique over existing objects, and drops them for one
 * that stops being unique. Core drives it from `migrateStorage`, inside serializable transactions
 * that each start with `lockPreparation`.
 */

/** A unique property whose values storage holds, and how their keys were computed. */
export interface PreparedUniqueProperty {
  readonly objectTypeId: string
  readonly propertyId: string
  readonly keyKind: UniqueValueKind
  readonly keyVersion: number
}

import type { UniqueValueKind } from "../../ontology/unique-values"

export interface UniqueValueEntry {
  readonly valueKey: string
  readonly primaryId: string
}

export interface OntologyUniqueValueStorage {
  /**
   * The first call of a preparation transaction: waits while another preparation transaction
   * runs, so concurrent startups queue instead of each scanning every object, and the snapshot
   * taken after it sees what the previous one committed. Writes are not blocked.
   */
  lockPreparation(input: { readonly projectId: string }): Promise<void>

  listPrepared(input: { readonly projectId: string }): Promise<readonly PreparedUniqueProperty[]>

  /** Drops every value of the property and its prepared record. */
  clear(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly propertyId: string
  }): Promise<void>

  /**
   * Adds values of the property. A value another object already holds, or that two entries give
   * to different objects, throws `UniqueValueViolationError` naming both objects.
   */
  insert(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly propertyId: string
    readonly entries: readonly UniqueValueEntry[]
  }): Promise<void>

  markPrepared(
    input: PreparedUniqueProperty & { readonly projectId: string; readonly preparedAt: string }
  ): Promise<void>
}
