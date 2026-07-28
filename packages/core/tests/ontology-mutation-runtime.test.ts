import { describe, expect, spyOn, test } from "bun:test"
import { createOntologyMutationRuntime } from "../src/runtime/internal"

type Materializer = Parameters<typeof createOntologyMutationRuntime>[0]["materializer"]

function materializerWithEventCount(eventCount: number): Materializer {
  const result = { eventCount } as never
  return {
    edits: { commit: async () => result },
    projections: {
      replace: async () => result,
      completeTelemetryInput: async () => undefined,
      finishRun: async () => undefined,
    },
    telemetry: { append: async () => result },
  }
}

describe("ontology mutation runtime", () => {
  test("wakes the outbox once after each commit that created facts", async () => {
    let wakes = 0
    const runtime = createOntologyMutationRuntime({
      materializer: materializerWithEventCount(2),
      notifyCommittedFacts: () => {
        wakes += 1
      },
    })

    await runtime.commitEdits({} as never)
    await runtime.replaceProjection({} as never)
    await runtime.appendTelemetry({} as never)
    await runtime.completeProjectionTelemetryInput({} as never)
    await runtime.finishProjection({} as never)

    expect(wakes).toBe(3)
  })

  test("does not wake for an empty commit or let wake-up failure reject a durable commit", async () => {
    let wakes = 0
    const empty = createOntologyMutationRuntime({
      materializer: materializerWithEventCount(0),
      notifyCommittedFacts: () => {
        wakes += 1
      },
    })
    await empty.commitEdits({} as never)
    expect(wakes).toBe(0)

    const committed = createOntologyMutationRuntime({
      materializer: materializerWithEventCount(1),
      notifyCommittedFacts: () => {
        throw new Error("wake failed")
      },
    })
    const reported = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await expect(committed.commitEdits({} as never)).resolves.toMatchObject({ eventCount: 1 })
      expect(reported).toHaveBeenCalledTimes(1)
    } finally {
      reported.mockRestore()
    }
  })
})
