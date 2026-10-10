import type { ActionRunDetail } from "@sixb/client"

/**
 * How long after a run ends its effects outcome can still land: their 30-second deadline, plus a
 * margin. Past it, the process that ran them stopped or could not record how they ended.
 */
export const EFFECTS_OUTCOME_WAIT_MS = 60_000

export type EffectsState = "none" | "pending" | "unrecorded" | "recorded"

/**
 * Where a run's effects stand. A run is recorded when it ends, and its effects run after that: a
 * run that committed edits and has effects stays in its commit phase until their outcome lands.
 */
export function effectsState(
  run: ActionRunDetail,
  hasEffects: boolean | undefined,
  now = Date.now()
): EffectsState {
  if (run.effects) return "recorded"
  if (run.status !== "succeeded" || run.phase !== "commit" || !hasEffects) return "none"
  return now - Date.parse(run.finishedAt) < EFFECTS_OUTCOME_WAIT_MS ? "pending" : "unrecorded"
}
