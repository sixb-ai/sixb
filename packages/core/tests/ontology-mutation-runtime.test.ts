import { describe, expect, spyOn, test } from "bun:test"
import type { BoundOntologyMaterializer } from "../src/materializer"
import { createOntologyMutationRuntime } from "../src/runtime/internal"

function materializerWithEventCount(eventCount: number): BoundOntologyMaterializer {
  const result = { eventCount } as never
  return {
    edits: { commit: async () => result },
    projections: {
      getActive: async () => null,
      replace: async () => result,
      finishRun: async () => undefined,
    },
    telemetry: { append: async () => result },
  }
}

describe("ontology mutation runtime", () => {
  test("wakes the outbox once after each commit that created facts", async () => {
    let wakes = 0
    const bound = materializerWithEventCount(2)
    const runtime = createOntologyMutationRuntime({
      materializer: bound,
      notifyCommittedFacts: () => {
        wakes += 1
      },
    })

    await runtime.commitEdits({} as never)
    await runtime.replaceProjection({} as never)
    await runtime.appendTelemetry({} as never)
    await runtime.finishProjection({} as never)

    expect(wakes).toBe(3)
  })

  // Reproduce: drop `applied(...)` around replaceProjection in createOntologyMutationRuntime; the
  // host's next read keeps the markings of the version the projection replaced.
  test("reports each projection that may have applied a version, even an empty one", async () => {
    const applied: string[] = []
    const runtime = createOntologyMutationRuntime({
      materializer: materializerWithEventCount(0),
      notifyCommittedFacts: () => {},
      onProjectionApplied: () => applied.push("applied"),
    })

    await runtime.commitEdits({} as never)
    await runtime.appendTelemetry({} as never)
    expect(applied).toEqual([])
    await runtime.replaceProjection({} as never)
    await runtime.finishProjection({} as never)
    expect(applied).toEqual(["applied", "applied"])
  })

  test("does not wake for an empty commit or let wake-up failure reject a durable commit", async () => {
    let wakes = 0
    const emptyBound = materializerWithEventCount(0)
    const empty = createOntologyMutationRuntime({
      materializer: emptyBound,
      notifyCommittedFacts: () => {
        wakes += 1
      },
    })
    await empty.commitEdits({} as never)
    expect(wakes).toBe(0)

    const committedBound = materializerWithEventCount(1)
    const committed = createOntologyMutationRuntime({
      materializer: committedBound,
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
