import { expect, test } from "bun:test"
import {
  defineWorkflow,
  defineWorkflowStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  question,
  SixbHost,
} from "@sixb/core"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import type { DecisionModel } from "@sixb/core/models"
import type { Storage } from "@sixb/core/storage"
import { startSixbRuntime, stopSixbProviders } from "../src/lib/runtime"
import { createWorkerForType, resolveRegisteredWorkerTypes } from "../src/lib/worker-registry"

for (const mode of ["cohost", "worker-group"] as const) {
  // Removal proof: gate either CLI startup path on the model catalog again.
  test(`${mode} recovers explicit model accounting without a catalog or agent dependencies`, async () => {
    const storage = new InMemoryStorage()
    let available = false
    let providerCalls = 0
    const recoveryStorage: Storage = {
      ...storage,
      ping: () => storage.ping(),
      agents: undefined,
      auth: undefined,
      transaction: (run, options) =>
        storage.transaction((tx) => {
          const usage = tx.aiUsage!
          return run({
            ...tx,
            aiUsage: {
              getLatestForExecution: (input) => usage.getLatestForExecution(input),
              summarizeExecution: (input) => usage.summarizeExecution(input),
              summarizeExecutions: (input) => usage.summarizeExecutions(input),
              recordModelCall: (input) => {
                if (!available) throw new Error("accounting temporarily unavailable")
                return usage.recordModelCall(input)
              },
            },
          })
        }, options),
    }
    const step = defineWorkflowStep("ordinary-step")
      .input({})
      .output({})
      .run(() => ({}))
    const host = new SixbHost({
      id: "explicit-model-recovery",
      ontology: [],
      workflows: [defineWorkflow("ordinary-workflow").input({}).then(step)],
      storage: recoveryStorage,
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
    })
    const model: DecisionModel = {
      providerId: "test",
      modelId: "decision",
      definition: {
        kind: "decision",
        providerId: "test",
        modelId: "decision",
        capabilities: { questions: ["probability"] },
      },
      async evaluate() {
        providerCalls++
        return { output: { urgent: { probability: 0.8 } }, usage: { inputTokens: 8 } }
      },
    }
    const sixb = bindRequestExecution(host, {
      request: new Request("http://localhost/decision"),
      authorization: { type: "disabled" },
    })
    const identity = { projectId: host.id, executionId: sixb.execution.id }
    let stop = () => stopSixbProviders(host)
    try {
      await expect(
        sixb.models.decision.evaluate({
          model,
          input: "Urgent repair",
          questions: { urgent: question.probability("Urgent?") },
        })
      ).rejects.toMatchObject({ name: "ModelUsageRecordingError", recoveryScheduled: true })
      expect((await storage.aiUsage.summarizeExecution(identity)).modelCallCount).toBe(0)
      available = true

      if (mode === "cohost") {
        const runtime = await startSixbRuntime(host, { cohostWorkers: true })
        stop = () => runtime.stop()
        expect(runtime.agentWorker).not.toBeNull()
      } else {
        const types = resolveRegisteredWorkerTypes(host)
        expect(types).toEqual(["agent", "workflow"])
        const workers = types.map((type) => createWorkerForType(host, type))
        stop = async () => {
          await Promise.all(workers.map((worker) => worker.stop()))
          await stopSixbProviders(host)
        }
        await Promise.all(workers.map((worker) => worker.start()))
      }

      const deadline = Date.now() + 2_000
      while ((await storage.aiUsage.summarizeExecution(identity)).modelCallCount === 0) {
        if (Date.now() >= deadline) throw new Error("Accounting recovery did not complete")
        await Bun.sleep(10)
      }
      const summary = await storage.aiUsage.summarizeExecution(identity)
      expect(summary.modelCallCount).toBe(1)
      expect(summary.usage.inputTokens).toBe(8)
      expect(providerCalls).toBe(1)
    } finally {
      await stop()
    }
  })
}
