import type { OntologyObjectRef } from "../materialization/model"
import type { GroupMembershipRecord } from "./auth"
import type { StoredObjectVector } from "./ontology/vectors"
import type { TimeseriesPoint } from "./timeseries/types"
import type { Storage } from "./types"

/**
 * A provider a snapshot of a project can be read from, consistently.
 * `packages/core/src/snapshots/README.md` describes the flow.
 */
export interface SnapshotReadStorage extends Storage {
  /**
   * Run `run` against read-only views of one consistent state. Every view sees the same state,
   * whatever is committed meanwhile. The provider bounds the read by `maxDurationMs` on its side
   * too, and closes it only once `run` has settled. A provider may give fewer views than asked,
   * never none.
   */
  readSnapshot<T>(
    options: SnapshotReadOptions,
    run: (views: readonly SnapshotReadView[]) => Promise<T>
  ): Promise<T>
}

export interface SnapshotReadOptions {
  /** How many views read in parallel. */
  readonly views: number
  /** How long the consistent read may stay open. */
  readonly maxDurationMs: number
}

/** One read-only view of the snapshot's state. */
export interface SnapshotReadView {
  readonly storage: Storage
  /** The stored vectors of these objects, with their values. */
  readVectors(input: {
    readonly projectId: string
    readonly refs: readonly OntologyObjectRef[]
  }): Promise<readonly StoredObjectVector[]>
  /** The latest point of each of these series that has one. */
  readLatestPoints(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly objectIds: readonly string[]
    readonly propertyIds: readonly string[]
  }): Promise<readonly TimeseriesPoint[]>
  /** Every group membership of the project, in one read. */
  readMemberships(input: { readonly projectId: string }): Promise<readonly GroupMembershipRecord[]>
  /**
   * Up to `parts` ranges covering every object of the type in primary id order, for views to
   * read side by side; none when the type is too small to split. Optional: without it, each
   * type is read whole.
   */
  readRanges?(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly parts: number
    /** Fewer objects than this, and the type is read whole. */
    readonly minObjects: number
  }): Promise<readonly SnapshotRange[]>
}

/**
 * One range of a type: its pages start at `startToken`, a page token of the provider's, and end
 * with the object `lastPrimaryId`, after which the next range starts. The last range has none.
 */
export interface SnapshotRange {
  readonly startToken?: string
  readonly lastPrimaryId?: string
}

export function isSnapshotReadStorage(storage: Storage): storage is SnapshotReadStorage {
  return "readSnapshot" in storage && typeof storage.readSnapshot === "function"
}
