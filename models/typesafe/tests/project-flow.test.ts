import { expect, test } from "bun:test"
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

/** `beforeAnswer` runs while Jev evaluates, before its answer reaches the caller. */
function setup(options: { readonly beforeAnswer?: () => Promise<void> } = {}) {
  let calls = 0
  const reportedErrors: string[] = []
  const jev = createTypesafe({
    apiKey: "test-key",
    fetch: async () => {
      calls++
      await options.beforeAnswer?.()
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
    onError: (error) => {
      reportedErrors.push(error.message)
    },
  })
  return { host, sixb: createTestSixb(host), calls: () => calls, reportedErrors }
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
  const { sixb, calls } = setup()
  await sixb.objects(Ticket).upsert({ properties: { id: "ticket", description: "Stopped" } })

  const run = await sixb
    .objects(Ticket)
    .requestAction({ id: "ticket", action: triageTicket, params: {} })

  expect(run.status).toBe("succeeded")
  expect((await sixb.objects(Ticket).get("ticket"))?.properties.category).toBe("maintenance")
  expect(run.writeback).toMatchObject({
    result: { description: "Stopped", output: { blocked: { probability: 0.9 } } },
  })
  expect(calls()).toBe(1)
})

test("the example rejects a decision made on a ticket that changed meanwhile", async () => {
  // Removal proof: remove the freshness guard in examples/triage.ts; the run then succeeds and
  // applies the stale "maintenance" category.
  const { sixb, calls, reportedErrors } = setup({
    beforeAnswer: async () => {
      await sixb.objects(Ticket).upsert({
        properties: { id: "ticket", description: "Already repaired", category: "other" },
      })
    },
  })
  await sixb.objects(Ticket).upsert({ properties: { id: "ticket", description: "Stopped" } })

  const run = await sixb
    .objects(Ticket)
    .requestAction({ id: "ticket", action: triageTicket, params: {} })

  expect(run.status).toBe("failed")
  expect(run.error?.details.phase).toBe("edits")
  expect(reportedErrors).toEqual(["Ticket changed; request a new triage."])
  expect(calls()).toBe(1)
  expect((await sixb.objects(Ticket).get("ticket"))?.properties.category).toBe("other")
})
