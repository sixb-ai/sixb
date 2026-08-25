import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "@sixb/core"
import { MockLanguageModelV4 } from "ai/test"
import { AgentWorker } from "../src"
import { waitFor } from "./helpers"
import {
  API_BASE_URL,
  answer,
  buildHost,
  CountingSandboxFactory,
  delegatingModel,
  PROJECT_ID,
  requestMainTurn,
  stream,
  withUnfinalizableChildRuns,
} from "./sub-agent-harness"

describe("sub_agent delegation failure", () => {
  test("does not report a child whose finalize was lost as an answer", async () => {
    const storage = withUnfinalizableChildRuns(new InMemoryStorage(), "researcher")
    const sixb = buildHost({
      mainModel: delegatingModel("researcher"),
      specialistModel: new MockLanguageModelV4({
        modelId: "specialist-model",
        doStream: async () => stream(answer("Invoices are late.")),
      }),
      sandboxes: new CountingSandboxFactory(),
      storage,
    })

    const requested = await requestMainTurn(sixb, ["agent-users"])
    const worker = new AgentWorker(sixb, {
      apiBaseUrl: API_BASE_URL,
      idlePollMs: 5,
      skillsDir: false,
    })
    await worker.start()
    try {
      // Settle on whichever happens first: the delegating run is redelivered (the fix — its job is
      // left for a later delivery to finalize), or it finalizes on its own (the regression).
      await waitFor(
        async () => {
          const parent = await sixb.storage.agents?.runs.getById({
            projectId: PROJECT_ID,
            id: requested.run.id,
          })
          if (!parent) return undefined
          return parent.attempt >= 2 || parent.status === "succeeded" ? parent : undefined
          // Redelivery waits out FINALIZE_RETRY_BACKOFF_MS (5s), so this needs more than the default.
        },
        { timeoutMs: 15_000, label: "delegating run redelivered or finalized" }
      )
    } finally {
      await worker.stop()
    }

    // The child did the work but its finalize could not be recorded. A thrown tool error becomes
    // tool-result text, so without `assertToolsHealthy` the delegating turn would sail past it and
    // finalize `succeeded` — permanently recording the opposite of what happened.
    const parent = await sixb.storage.agents?.runs.getById({
      projectId: PROJECT_ID,
      id: requested.run.id,
    })
    // The delegating turn must not ack a delivery whose child finalize was lost: its job is left
    // for redelivery, which shows up as a second attempt. Without `assertToolsHealthy` the thrown
    // error is swallowed into tool-result text, the turn finalizes on attempt 1, and the lost child
    // is silently reported to the user as an answer.
    expect(parent?.attempt).toBeGreaterThanOrEqual(2)
  }, 30_000) // That silence is why this lives in the e2e lane rather than the unit suite. // The delegating job is left for redelivery, which waits out FINALIZE_RETRY_BACKOFF_MS (5s).
})
