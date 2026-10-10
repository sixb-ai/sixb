import { assertJsonValue, cloneJsonValue } from "../../json"
import { ActionRunError } from "./errors"
import { parseActionRunFailure } from "./failure"
import { actionRunPhaseRecordsEqual } from "./idempotency"
import type {
  ActionRunEffectsRecord,
  ActionRunRecord,
  ActionRunWritebackRecord,
  RecordActionEffectsInput,
  RecordActionRunInput,
} from "./types"
import { ACTION_RUN_PHASES } from "./types"

/**
 * Validate a terminal run record before a provider inserts it, and detach it from the caller.
 *
 * Every provider records through this, so a stored run always reads back as the record that was
 * written: a failed run carries the failure of the phase it ended in, and a succeeded one none. A
 * run is recorded before its effects run, so no record starts in the `effects` phase.
 */
export function normalizeRecordActionRunInput(input: RecordActionRunInput): RecordActionRunInput {
  const label = `[Sixb] Action run '${input.id}'`
  for (const field of ["id", "projectId", "executionId", "actionId", "idempotencyKey"] as const) {
    if (typeof input[field] !== "string" || input[field].trim().length === 0) {
      throw new ActionRunError(`${label} must have a nonblank ${field}.`)
    }
  }
  const status: string = input.status
  if (status !== "succeeded" && status !== "failed") {
    throw new ActionRunError(`${label} has unknown status '${status}'.`)
  }
  if (!(ACTION_RUN_PHASES as readonly string[]).includes(input.phase)) {
    throw new ActionRunError(`${label} has unknown phase '${input.phase}'.`)
  }
  if (input.phase === "effects") {
    throw new ActionRunError(`${label} is recorded before its effects run.`)
  }
  const startedAt = requireDate(input.startedAt, `${label} startedAt`)
  const finishedAt = requireDate(input.finishedAt, `${label} finishedAt`)
  if (finishedAt < startedAt) {
    throw new ActionRunError(`${label} cannot finish before it started.`)
  }
  assertJsonValue(input.params, `${label} params`)

  const fields = {
    id: input.id,
    projectId: input.projectId,
    executionId: input.executionId,
    actionId: input.actionId,
    subject: structuredClone(input.subject),
    phase: input.phase,
    startedAt,
    finishedAt,
    params: structuredClone(input.params),
    idempotencyKey: input.idempotencyKey,
    ...(input.writeback === undefined
      ? {}
      : { writeback: normalizeWriteback(input.writeback, label) }),
  }

  if (input.status === "succeeded") {
    if (input.error !== undefined) {
      throw new ActionRunError(`${label} succeeded, so it cannot record a failure.`)
    }
    return { ...fields, status: "succeeded" }
  }
  const error = parseActionRunFailure(input.error, input.phase)
  if (error.details.runId !== input.id || error.details.actionId !== input.actionId) {
    throw new ActionRunError(`${label} records the failure of another run.`)
  }
  return { ...fields, status: "failed", error }
}

/**
 * Resolve what recording effects does to the stored run: write `effects`, or nothing (`null`) when
 * an equal outcome is already recorded.
 *
 * Effects run only after a succeeded run committed its edits, and their outcome is recorded once.
 */
export function resolveActionRunEffects(
  existing: ActionRunRecord | null,
  input: RecordActionEffectsInput
): { readonly run: ActionRunRecord; readonly effects: ActionRunEffectsRecord | null } {
  const label = `[Sixb] Action run '${input.id}'`
  if (!existing) {
    throw new ActionRunError(`${label} not found for project '${input.projectId}'.`)
  }
  const completedAt = requireDate(input.completedAt ?? new Date(), `${label} effects`)
  const effects: ActionRunEffectsRecord =
    input.status === "succeeded"
      ? { status: "succeeded", completedAt }
      : { status: "failed", completedAt, error: parseActionRunFailure(input.error, "effects") }

  if (existing.effects) {
    if (actionRunPhaseRecordsEqual(existing.effects, effects))
      return { run: existing, effects: null }
    throw new ActionRunError(`${label} already has a different effects record.`)
  }
  if (existing.status !== "succeeded" || existing.phase !== "commit") {
    throw new ActionRunError(
      `${label} cannot record effects: it ended '${existing.status}' in phase '${existing.phase}'.`
    )
  }
  return { run: existing, effects }
}

function normalizeWriteback(
  writeback: ActionRunWritebackRecord,
  label: string
): ActionRunWritebackRecord {
  const completedAt = requireDate(writeback.completedAt, `${label} writeback`)
  if (writeback.status === "succeeded") {
    assertJsonValue(writeback.result, `${label} writeback result`)
    return { status: "succeeded", completedAt, result: cloneJsonValue(writeback.result) }
  }
  return {
    status: "failed",
    completedAt,
    error: parseActionRunFailure(writeback.error, "writeback"),
  }
}

/** A detached copy of `value`, which must be a valid date. */
function requireDate(value: Date, label: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(Number.NaN)
  if (!Number.isFinite(date.getTime())) {
    throw new ActionRunError(`${label} must be a valid date.`)
  }
  return date
}
