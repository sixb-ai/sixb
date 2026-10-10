import { describe, expect, test } from "bun:test"
import type { ActionRunDetail } from "@sixb/client"
import { EFFECTS_OUTCOME_WAIT_MS, effectsState } from "../src/lib/actions/effects"

const finishedAt = "2026-06-29T12:00:00.000Z"
const finished = Date.parse(finishedAt)

function run(overrides: Partial<ActionRunDetail> = {}): ActionRunDetail {
  return {
    id: "act_1",
    projectId: "proj",
    actionId: "notify",
    subject: { kind: "none" },
    status: "succeeded",
    phase: "commit",
    startedAt: "2026-06-29T11:59:59.000Z",
    finishedAt,
    params: {},
    ...overrides,
  }
}

describe("effectsState", () => {
  // Guard proof: drop the time bound from `effectsState` (`src/lib/actions/effects.ts`), and a run
  // whose effects outcome never lands stays pending, so its page polls forever.
  test("waits for an effects outcome only for a while after the run ended", () => {
    expect(effectsState(run(), true, finished + 1_000)).toBe("pending")
    expect(effectsState(run(), true, finished + EFFECTS_OUTCOME_WAIT_MS)).toBe("unrecorded")
  })

  test("reads a recorded outcome, and runs without effects, as settled", () => {
    const effects = { status: "succeeded" as const, completedAt: finishedAt }
    expect(effectsState(run({ phase: "effects", effects }), true, finished)).toBe("recorded")
    expect(effectsState(run(), false, finished)).toBe("none")
    expect(effectsState(run({ phase: "writeback" }), true, finished)).toBe("none")
    expect(effectsState(run({ status: "failed" }), true, finished)).toBe("none")
  })
})
