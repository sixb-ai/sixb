import { expect, test } from "bun:test"
import { ActionWorker } from "@sixb/action-worker"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { Ticket, triage, triageQuestions, triageTicket } from "../examples/triage"
import { createTypesafe } from "../src"

function setup() {
  let calls = 0
  const jev = createTypesafe({
    apiKey: "test-key",
    fetch: async () => {
      calls++
      return Response.json({
        model: "jev-1.13.0",
        usage: { input_tokens: 100, output_tokens: 25 },
        answers: {
          category: {
            type: "choice",
            choice: "maintenance",
            probabilities: { maintenance: 0.9, billing: 0, other: 0.1 },
            confidence: 0.7,
          },
          severity: {
            type: "score",
            score: 2,
            probabilities: { "0": 0, "1": 0, "2": 1 },
            confidence: 1,
          },
          blocked: { type: "noul", noul: 0.9 },
        },
      })
    },
  })("jev-1.13.0")
  const host = new SixbHost({
    id: "triage-example",
    ontology: [Ticket],
    actions: [triageTicket],
    models: { decision: [jev] },
    storage: new InMemoryStorage(),
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
  })
  return { host, sixb: createTestSixb(host), calls: () => calls }
}

test("the documented questions work through the runtime and retain priced output usage", async () => {
  const { host, sixb, calls } = setup()
  const result = await sixb.models.decision.evaluate({
    input: { description: "Stopped" },
    questions: triageQuestions,
  })
  expect(result.output.category.choice).toBe("maintenance")
  expect(result.cost).toMatchObject({ status: "rated", money: { amountNanos: "4200" } })
  expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 25 })
  expect(calls()).toBe(1)
  expect(triage.id).toBe("triage")
  const usage = await host.storage.aiUsage!.getLatestForExecution({
    projectId: host.id,
    executionId: sixb.execution.id,
  })
  expect(usage).toMatchObject({ callId: result.callId, usage: { totalTokens: 125 } })
})

test("the action example persists and applies a decision", async () => {
  const { host, sixb, calls } = setup()
  await sixb.objects(Ticket).upsert({ properties: { id: "ticket", description: "Stopped" } })
  const worker = new ActionWorker(host)
  await worker.start()
  try {
    const run = await sixb
      .objects(Ticket)
      .requestActionAndWait({ id: "ticket", actionId: triageTicket.id })
    expect(run.status).toBe("succeeded")
    expect((await sixb.objects(Ticket).get("ticket"))?.properties.category).toBe("maintenance")
    expect(run.writeback).toMatchObject({
      result: { description: "Stopped", output: { blocked: { probability: 0.9 } } },
    })
    expect(calls()).toBe(1)
  } finally {
    await worker.stop()
  }
})

test("the example rejects a stale persisted decision on redelivery without calling Jev again", async () => {
  // Removal proof: remove the freshness guard in examples/triage.ts; the run then succeeds.
  const { host, sixb, calls } = setup()
  await sixb
    .objects(Ticket)
    .upsert({ properties: { id: "ticket", description: "Already repaired", category: "other" } })
  const { runId } = await sixb
    .objects(Ticket)
    .requestAction({ id: "ticket", actionId: triageTicket.id })
  await host.storage.actionRuns!.start({ projectId: host.id, id: runId })
  await host.storage.actionRuns!.recordWriteback({
    projectId: host.id,
    id: runId,
    status: "succeeded",
    result: {
      description: "Stopped",
      previousCategory: null,
      callId: "earlier-call",
      output: {
        category: {
          choice: "maintenance",
          probabilities: { maintenance: 1, billing: 0, other: 0 },
        },
        severity: { score: 2, probabilities: [0, 0, 1] },
        blocked: { probability: 1 },
      },
    },
  })
  const worker = new ActionWorker(host)
  await worker.start()
  try {
    const deadline = Date.now() + 2000
    let run = await host.storage.actionRuns!.getById({ projectId: host.id, id: runId })
    while (run?.status !== "failed" && run?.status !== "succeeded" && Date.now() < deadline) {
      await Bun.sleep(10)
      run = await host.storage.actionRuns!.getById({ projectId: host.id, id: runId })
    }
    expect(run?.status).toBe("failed")
    expect(calls()).toBe(0)
    expect((await sixb.objects(Ticket).get("ticket"))?.properties.category).toBe("other")
  } finally {
    await worker.stop()
  }
})
