import type { JsonValue } from "../json"
import type {
  LinkOverride,
  LinkSlotOverride,
  ObjectOverride,
  OntologyLinkRef,
  OntologyObjectRef,
  PinnedDatasetVersion,
  ProjectionEntityRef,
  ProjectionSourceAssertion,
} from "../materialization/model"
import type { GroupMembershipRecord } from "./auth"
import type { OntologyCommitRecord } from "./ontology/commits"
import type { ExactArtifactHolderWrite, ExactUniqueValueClaim } from "./ontology/materializations"
import type { PreparedUniqueProperty } from "./ontology/unique-values"
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

/** A provider a snapshot can be loaded into, as one base commit. */
export interface SnapshotLoadStorage extends Storage {
  /**
   * Load a snapshot as one base commit: no event, no outbox row. `run` writes the batches; the
   * provider builds what it indexes after the last one. It is all or nothing: a failure leaves the
   * storage as it was. It refuses a storage that holds an object already, and nothing may read
   * the storage while it loads.
   */
  loadSnapshot<T>(input: SnapshotLoadInput, run: (loader: SnapshotLoader) => Promise<T>): Promise<T>
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
  /**
   * Live roots of a projection's active source, in root key order after `afterRootKey`, each with
   * what it asserts.
   */
  readSourceRoots(input: {
    readonly projectId: string
    readonly projectionId: string
    readonly afterRootKey?: string
    readonly limit: number
  }): Promise<readonly SnapshotSourceRoot[]>
  /** A page of the edits over a type's objects, in primary id order after `afterPrimaryId`. */
  readObjectEdits(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly afterPrimaryId?: string
    readonly limit: number
  }): Promise<readonly SnapshotObjectEdit[]>
  /**
   * A page of the edits over links from a type's objects, edges and cardinality-one slots, in
   * `key` order after `afterKey`.
   */
  readLinkEdits(input: {
    readonly projectId: string
    readonly sourceTypeId: string
    readonly afterKey?: string
    readonly limit: number
  }): Promise<readonly SnapshotLinkEditRow[]>
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

export interface SnapshotSourceRoot {
  /** `projectionEntityKey(root)`, the order roots are read in. */
  readonly rootKey: string
  readonly root: ProjectionEntityRef
  readonly assertions: readonly ProjectionSourceAssertion[]
}

export interface SnapshotTypeEdits {
  readonly objects: readonly SnapshotObjectEdit[]
  readonly links: readonly SnapshotLinkEdit[]
  readonly slots: readonly SnapshotLinkSlotEdit[]
}

/** A link edit as a page reads it: `key` orders the pages, and means nothing else. */
export type SnapshotLinkEditRow =
  | ({ readonly kind: "edge"; readonly key: string } & SnapshotLinkEdit)
  | ({ readonly kind: "slot"; readonly key: string } & SnapshotLinkSlotEdit)

export interface SnapshotObjectEdit {
  readonly ref: OntologyObjectRef
  readonly value: ObjectOverride
  /** When each property the edit sets was last edited. */
  readonly editedAt?: Readonly<Record<string, string>>
  readonly updatedAt: string
}

export interface SnapshotLinkEdit {
  readonly ref: OntologyLinkRef
  readonly value: LinkOverride
  readonly updatedAt: string
}

export interface SnapshotLinkSlotEdit {
  readonly source: OntologyObjectRef
  readonly linkId: string
  readonly value: LinkSlotOverride
  readonly updatedAt: string
}

export interface SnapshotLoadInput {
  readonly projectId: string
  /** The base commit every loaded row belongs to. Its execution must exist already. */
  readonly commit: OntologyCommitRecord
  /** Unique properties whose values the batches claim, prepared as of this load. */
  readonly uniqueProperties: readonly PreparedUniqueProperty[]
  /** Object types the batches write, so a provider can lay out their storage before the load. */
  readonly objectTypeIds: readonly string[]
}

export interface SnapshotLoader {
  write(batch: SnapshotLoadBatch): Promise<void>
}

/** Rows of one batch, in the shapes the base commit stores them. Every row is new. */
export interface SnapshotLoadBatch {
  readonly objects?: readonly SnapshotObjectWrite[]
  readonly links?: readonly SnapshotLinkWrite[]
  readonly points?: readonly SnapshotPointWrite[]
  readonly uniqueValues?: readonly ExactUniqueValueClaim[]
  readonly artifactHolders?: readonly ExactArtifactHolderWrite[]
  readonly vectors?: readonly StoredObjectVector[]
  /**
   * A projection's active source, taken over from production, before any of its roots. The
   * provider counts its roots and assertions once the load wrote them.
   */
  readonly sources?: readonly SnapshotSourceWrite[]
  readonly sourceRoots?: readonly SnapshotSourceRootWrite[]
  readonly edits?: SnapshotTypeEdits
}

/**
 * A projection's source, active as of the base commit, with production's identity: the branch's
 * projection continues from it when its own identity is the same.
 */
export interface SnapshotSourceWrite {
  readonly projectionId: string
  readonly materializationId: string
  readonly datasetVersion: PinnedDatasetVersion
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly ontologyRevision: string
}

export interface SnapshotSourceRootWrite {
  readonly projectionId: string
  readonly materializationId: string
  readonly rootKey: string
  readonly root: ProjectionEntityRef
  /** The root's place among the source's roots, from 0. */
  readonly stagingOrdinal: number
  readonly assertions: readonly ProjectionSourceAssertion[]
}

/**
 * An object of the base commit: its effective row, and the edit that creates it. An object a
 * source asserts has none: its source and the edits over it (`edits`) make it what it is.
 */
export interface SnapshotObjectWrite {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly properties: Readonly<Record<string, JsonValue>>
  readonly override?: Extract<ObjectOverride, { readonly kind: "create" }>
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * A link created by the base commit, and the edit that creates it: the edge's own for a
 * cardinality-many link, its slot's for a cardinality-one link.
 */
export interface SnapshotLinkWrite {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
  readonly properties?: Readonly<Record<string, JsonValue>>
  /** The edit that creates it, or none for a link a source asserts. */
  readonly identity: "edge" | "slot" | "source"
  readonly createdAt: string
  readonly updatedAt: string
}

/** The latest value of one telemetry series. History is never part of a snapshot. */
export interface SnapshotPointWrite {
  readonly objectTypeId: string
  readonly objectId: string
  readonly propertyId: string
  readonly value: JsonValue
  readonly unit?: string
  readonly at: string
}

/**
 * A provider that keeps branches apart: each namespace is a storage of its own, which nothing
 * written to another namespace or to this storage reaches.
 */
export interface BranchNamespaceStorage {
  /** Create the namespace, ready to load a snapshot into. Refuses one that exists. */
  createBranchNamespace(name: string): Promise<BranchNamespace>
  /** The namespace's storage, or null when it does not exist. */
  openBranchNamespace(name: string): Promise<BranchNamespace | null>
  listBranchNamespaces(): Promise<readonly string[]>
  /** Drop the namespace and everything in it. Dropping a missing one does nothing. */
  dropBranchNamespace(name: string): Promise<void>
}

const BRANCH_NAMESPACE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Refuse a name a provider could not hold in every engine: lowercase, digits and dashes. */
export function assertBranchNamespaceName(name: string): void {
  if (typeof name === "string" && BRANCH_NAMESPACE_NAME.test(name)) return

  throw new Error(
    `[Sixb] Branch namespace '${String(name)}' is invalid: use 1 to 40 lowercase letters, digits or dashes, starting with a letter or a digit.`
  )
}

/** Every property of an object a snapshot creates was edited when the object last changed. */
export function snapshotEditedAt(
  properties: Readonly<Record<string, unknown>>,
  at: string
): Record<string, string> {
  const edited: Record<string, string> = {}
  for (const propertyId of Object.keys(properties)) edited[propertyId] = at
  return edited
}

export function branchNamespaceExists(name: string): Error {
  return new Error(
    `[Sixb] Branch namespace '${name}' exists already: open it, or drop it to start again.`
  )
}

export function snapshotTargetNotEmpty(): Error {
  return new Error(
    "[Sixb] A snapshot loads only into a storage that holds no object yet: load it into a new branch namespace."
  )
}

/** A branch namespace's storage: what a snapshot loads into, and a branch then runs on. */
export type BranchNamespace = SnapshotReadStorage & SnapshotLoadStorage

export function isSnapshotReadStorage(storage: Storage): storage is SnapshotReadStorage {
  return "readSnapshot" in storage && typeof storage.readSnapshot === "function"
}

export function isSnapshotLoadStorage(storage: Storage): storage is SnapshotLoadStorage {
  return "loadSnapshot" in storage && typeof storage.loadSnapshot === "function"
}

export function isBranchNamespaceStorage(
  storage: Storage
): storage is Storage & BranchNamespaceStorage {
  return "createBranchNamespace" in storage && typeof storage.createBranchNamespace === "function"
}
