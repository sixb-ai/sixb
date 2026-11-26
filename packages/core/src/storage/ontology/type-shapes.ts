/**
 * The shape the stored objects of each type fit, and the reads that decide whether they still fit
 * another one. Core drives it from `migrateStorage`: it compares each stored shape with the code's,
 * probes the stores for the changes that narrow, and records the code's shape once the data fits.
 */

import type { ObjectOverride } from "../../materialization/model"
import type { TypeShape } from "../../ontology/type-shapes"

export interface StoredTypeShape {
  readonly objectTypeId: string
  readonly shape: TypeShape
  /**
   * The shape recorded before `shape`, by the deploy that recorded `shape`: what the previous
   * release's code defines, which a role of that release may start on. `null` when there was none,
   * or when the previous release can't serve the data any more, as after a migration run.
   */
  readonly previous: TypeShape | null
  /**
   * `migrating` from the point of no return of a migration run until it finishes: roles refuse to
   * start, and `sixb db migrate --check` exits 4.
   */
  readonly state: "current" | "migrating"
  readonly updatedAt: string
}

/** What recording writes: a shape the stored objects fit. A row's state is left as it is. */
export type TypeShapeWrite = Omit<StoredTypeShape, "state"> & { readonly projectId: string }

/**
 * What one probe looks for among a type's stored data. Each reads every store the key can live in:
 *
 * - `property`: an object, an edit (`create`, `patch.set` and `unset`, its edit times, a losing
 *   one included), a live source row (its values or `absentSourcePropertyIds`, one hidden by a
 *   delete included) or a telemetry series holds the key.
 * - `missingRequired`: an object created by an edit, with no source row, lacks the key, or an
 *   edit's `unset` cleared it.
 * - `link`: a link, a link edit (an edge, or a slot, `clear` and `legacy-conflict` included) or a
 *   live source row of that link exists.
 * - `type`: any of the above holds anything of the type.
 */
export type TypeShapeProbe =
  | { readonly kind: "property"; readonly propertyId: string }
  | { readonly kind: "missingRequired"; readonly propertyId: string }
  | { readonly kind: "link"; readonly linkId: string }
  | { readonly kind: "type" }

export interface TypeShapeProbeInput {
  readonly projectId: string
  readonly objectTypeId: string
  readonly probe: TypeShapeProbe
}

/** One object's edit, as stored: a losing one included, since the store keeps it. */
export interface StoredObjectEdit {
  readonly primaryId: string
  readonly value: Exclude<ObjectOverride, { readonly kind: "delete" }>
  readonly editedAt: Readonly<Record<string, string>>
}

export interface ListObjectEditsInput {
  readonly projectId: string
  readonly objectTypeId: string
  /** Only the edits that give this property a value, in `create.properties` or `patch.set`. */
  readonly withValueOf?: string
  readonly afterPrimaryId?: string
  readonly limit: number
}

export interface OntologyTypeShapeStorage {
  /**
   * The first call of a recording transaction: waits while another one runs, so roles starting
   * together record one after another, and each sees what the previous one wrote.
   */
  lock(input: { readonly projectId: string }): Promise<void>

  list(input: { readonly projectId: string }): Promise<readonly StoredTypeShape[]>

  write(input: TypeShapeWrite): Promise<void>

  remove(input: { readonly projectId: string; readonly objectTypeId: string }): Promise<void>

  /** Whether the probe finds anything; stops at the first row that matches. */
  holds(input: TypeShapeProbeInput): Promise<boolean>

  /** How many objects the probe finds, by primary id: read only to report a failure. */
  count(input: TypeShapeProbeInput): Promise<number>

  /**
   * The link ids and telemetry property ids the type's stored data holds, whatever the code
   * declares: in links, link edits and live source link rows, and in telemetry series.
   */
  listHeldKeys(input: { readonly projectId: string; readonly objectTypeId: string }): Promise<{
    readonly linkIds: readonly string[]
    readonly seriesPropertyIds: readonly string[]
  }>

  /**
   * The property keys the type's objects and edits hold, whatever the code declares: in object
   * values, `create.properties`, `patch.set` and `unset`, edit times, and telemetry series. Keys
   * only, in one pass over the type: no value is read or returned.
   */
  listHeldPropertyKeys(input: {
    readonly projectId: string
    readonly objectTypeId: string
  }): Promise<readonly string[]>

  /** A keyset page of the type's `create` and `patch` edits, by primary id. Deletes hold no values. */
  listEdits(input: ListObjectEditsInput): Promise<{
    readonly edits: readonly StoredObjectEdit[]
    readonly nextPrimaryId?: string
  }>
}
