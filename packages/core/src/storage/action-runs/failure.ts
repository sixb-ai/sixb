import { parseSixbFailure } from "../../errors/internal"
import { isPlainRecord } from "../../json"
import {
  ACTION_RUN_FAILURE_CODES,
  ACTION_RUN_PHASES,
  type ActionRunFailure,
  type ActionRunFailureDetails,
  type ActionRunPhase,
} from "./types"

/** Serializes the canonical failure plus Action's typed lifecycle extension. */
export function serializeActionRunFailure<TPhase extends ActionRunPhase>(
  failure: ActionRunFailure<TPhase>,
  expectedPhase?: TPhase
): string {
  const parsed =
    expectedPhase === undefined
      ? parseActionRunFailure(failure)
      : parseActionRunFailure(failure, expectedPhase)
  return JSON.stringify(parsed)
}

/** Validates and detaches an Action failure read from a storage boundary. */
export function parseActionRunFailure<TPhase extends ActionRunPhase>(
  value: unknown,
  expectedPhase: TPhase
): ActionRunFailure<TPhase>
export function parseActionRunFailure(value: unknown): ActionRunFailure
export function parseActionRunFailure(
  value: unknown,
  expectedPhase?: ActionRunPhase
): ActionRunFailure {
  const candidate = parseStoredActionRunFailureValue(value)
  const failure = parseSixbFailure(candidate, ACTION_RUN_FAILURE_CODES)
  const details = failure.details
  if (
    !isPlainRecord(details) ||
    typeof details.actionId !== "string" ||
    typeof details.runId !== "string" ||
    typeof details.phase !== "string" ||
    !(ACTION_RUN_PHASES as readonly string[]).includes(details.phase)
  ) {
    throw new Error(
      "[Sixb] Stored failure is invalid: Action details must contain actionId, runId, and a known phase."
    )
  }
  if (expectedPhase !== undefined && details.phase !== expectedPhase) {
    throw new Error(`[Sixb] Stored Action ${expectedPhase} failure has phase '${details.phase}'.`)
  }

  return {
    ...failure,
    details: details as unknown as ActionRunFailureDetails,
  }
}

function parseStoredActionRunFailureValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error("[Sixb] Stored failure is invalid: value is not valid JSON.")
  }
}
