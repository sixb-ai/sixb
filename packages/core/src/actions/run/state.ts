import type { JsonValue } from "../../json"
import type {
  ActionRunFailure,
  ActionRunPhase,
  ActionRunWritebackRecord,
  RecordActionRunInput,
} from "../../storage"
import type { PendingActionRun } from "./types"

export type SucceededActionRunRecord = Extract<
  RecordActionRunInput,
  { readonly status: "succeeded" }
>
export type FailedActionRunRecord = Extract<RecordActionRunInput, { readonly status: "failed" }>

/**
 * What a run has done so far: the phase it reached and how its writeback ended.
 *
 * It lives in memory while the run executes, and nothing about the run is stored before it ends:
 * its terminal record is built from this state once, when it succeeds or fails.
 */
export class ActionRunState {
  private reached: ActionRunPhase = "validation"
  private writebackRecord: ActionRunWritebackRecord | undefined

  constructor(
    readonly run: PendingActionRun,
    /** When the run started executing, as its handlers and its record see it. */
    readonly startedAt: Date
  ) {}

  /** The last phase the run reached. */
  get phase(): ActionRunPhase {
    return this.reached
  }

  get writeback(): ActionRunWritebackRecord | undefined {
    return this.writebackRecord
  }

  /** The value a succeeded writeback returned, which edits and effects receive. */
  get writebackValue(): JsonValue | undefined {
    return this.writebackRecord?.status === "succeeded" ? this.writebackRecord.result : undefined
  }

  /**
   * Whether the run's deadline and caller no longer apply to it.
   *
   * True once its writeback succeeded, or once its commit started for an Action without one: from
   * there the run either commits or fails on its own merits.
   */
  get pastBoundary(): boolean {
    return this.writebackRecord?.status === "succeeded" || this.reached === "commit"
  }

  /** Enter a phase before the commit. The run is recorded before its effects run. */
  enter(phase: Exclude<ActionRunPhase, "effects">): void {
    this.reached = phase
  }

  /** Keep how the writeback ended. A run calls its writeback once, so this is set once. */
  recordWriteback(writeback: ActionRunWritebackRecord): void {
    if (this.writebackRecord) {
      throw new Error(`[Sixb] Action run '${this.run.id}' already ended its writeback.`)
    }
    this.writebackRecord = writeback
  }

  /** The record of the run succeeding in the phase it reached. */
  succeeded(finishedAt: Date = new Date()): SucceededActionRunRecord {
    return { ...this.recordFields(this.reached, finishedAt), status: "succeeded" }
  }

  /** The record of the run failing with `error`, in the phase the failure names. */
  failed(error: ActionRunFailure, finishedAt: Date = new Date()): FailedActionRunRecord {
    return { ...this.recordFields(error.details.phase, finishedAt), status: "failed", error }
  }

  private recordFields(phase: ActionRunPhase, finishedAt: Date) {
    const { id, projectId, executionId, actionId, subject, params, idempotencyKey } = this.run
    return {
      id,
      projectId,
      executionId,
      actionId,
      subject,
      params,
      idempotencyKey,
      phase,
      startedAt: this.startedAt,
      finishedAt,
      ...(this.writebackRecord === undefined ? {} : { writeback: this.writebackRecord }),
    }
  }
}
