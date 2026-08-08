import { parseSixbFailure } from "../../errors/internal"
import { isPlainRecord } from "../../json"
import {
  ACTION_RUN_FAILURE_CODES,
  ACTION_RUN_PHASES,
  type ActionRunFailure,
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
  if (
    !isPlainRecord(candidate) ||
    typeof candidate.phase !== "string" ||
    !(ACTION_RUN_PHASES as readonly string[]).includes(candidate.phase)
  ) {
    throw new Error("[Sixb] Stored failure is invalid: phase is not a known Action run phase.")
  }
  if (expectedPhase !== undefined && candidate.phase !== expectedPhase) {
    throw new Error(`[Sixb] Stored Action ${expectedPhase} failure has phase '${candidate.phase}'.`)
  }

  return {
    ...failure,
    phase: candidate.phase as ActionRunPhase,
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
