import type {
  EffectiveChangeCounts,
  ProjectionEntityRef,
  ProjectionExecution,
  ProjectionSourceRef,
} from "../../materialization/model"
import type { OntologyCommitWrite } from "./commits"
import type {
  MaterializationObjectExistence,
  MaterializationWorkRecord,
  SourceReplacementLinkState,
  SourceReplacementObjectState,
} from "./materializations"

/** A ready replacement candidate whose plan the calling execution builds or commits. */
export interface ReplacementPlanRef {
  readonly projectId: string
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly execution: ProjectionExecution
}

export interface OpenReplacementPlanInput extends ReplacementPlanRef {
  /** The commit the plan's work will carry, timed for a plan opened now. */
  readonly commit: OntologyCommitWrite
}

export interface OpenedReplacementPlan {
  /**
   * The time of the commit the plan's work carries: a resumed plan keeps the one it was opened
   * with. Its work is staged, and its session begins, with the commit at exactly this time.
   */
  readonly committedAt: string
}

export interface StreamReplacementPlanStateInput extends ReplacementPlanRef {
  /** Objects are planned before links: link state needs the planned existence of its endpoints. */
  readonly entityKind: "object" | "link"
  readonly pageRows: number
}

export interface ReplacementPlanStatePage {
  readonly objects: readonly SourceReplacementObjectState[]
  readonly links: readonly SourceReplacementLinkState[]
  /** Existence of the endpoints of `links`: as this plan leaves them, else as effective. */
  readonly endpoints: readonly MaterializationObjectExistence[]
}

export interface PlannedReplacementIdentity {
  readonly identity: ProjectionEntityRef
  /** Every work record this identity contributes, possibly none. */
  readonly records: readonly MaterializationWorkRecord[]
}

export interface StageReplacementPlanInput extends ReplacementPlanRef {
  /** The commit the plan carries, timed as `open` returned; every record is checked against it. */
  readonly commit: OntologyCommitWrite
  /** Identities of the page streamed last, each planned with the revision it was read at. */
  readonly planned: readonly PlannedReplacementIdentity[]
}

export interface PurgeReplacementPlansInput {
  readonly projectId: string
  /** Maximum rows one call deletes. */
  readonly limit: number
}

export type ReplacementPlanStatus =
  | { readonly fresh: true; readonly counts: EffectiveChangeCounts }
  /** Identities that changed since they were planned, and those planned from them, are planned again. */
  | { readonly fresh: false; readonly unplanned: number }

/**
 * The durable plan of a ready replacement candidate.
 *
 * It is built outside the commit transaction, one page at a time, and belongs to the candidate: a
 * redelivery resumes it, and the candidate's end removes it. Every identity keeps the revision of
 * the inputs its plan was read from. `refresh`, inside the commit transaction, plans again what
 * changed since, so a commit only ever applies a plan that is still exact.
 */
export interface OntologyReplacementPlanStorage {
  /**
   * Opens the candidate's plan, or resumes the one an earlier execution of its run left. A plan
   * decides the entities of the active source it replaces: once that moved, it starts over.
   */
  open(input: OpenReplacementPlanInput): Promise<OpenedReplacementPlan>
  /**
   * State of the identities still to plan, in canonical order; each page reads one snapshot. The
   * link stream first adds the links the planned objects reach: those incident to an object whose
   * existence flips, and the members of every scope a planned link changes.
   */
  streamState(input: StreamReplacementPlanStateInput): AsyncIterable<ReplacementPlanStatePage>
  /** Plans identities streamed since they were last unplanned; each is planned once. */
  stage(input: StageReplacementPlanInput): Promise<void>
  /**
   * Within the commit transaction, before the plan-bound session begins: unplans every planned
   * identity whose inputs changed, with every identity planned from it. A fresh plan returns the
   * change counts its commit reports.
   */
  refresh(input: ReplacementPlanRef): Promise<ReplacementPlanStatus>
  /**
   * Deletes what is left of plans whose candidate is no longer ready, a bounded number of rows at
   * a time, and returns how many it deleted. A commit or an abandon may leave its plan behind: the
   * rows are a cache nothing reads once the candidate moved on.
   */
  purge(input: PurgeReplacementPlansInput): Promise<number>
}
