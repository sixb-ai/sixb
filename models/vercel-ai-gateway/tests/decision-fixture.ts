import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  question,
  SixbHost,
} from "@sixb/core"
import type { DecisionModel } from "@sixb/core/models"
import { createTestSixb } from "@sixb/core/testing"

export const decisionQuestions = {
  category: question.choice({
    instructions: "Which department handles this issue?",
    options: { billing: "Payments and refunds", technical: "Software errors" },
  }),
  impact: question.score({
    instructions: "How urgent is this issue?",
    levels: ["Not urgent", "Urgent", "Critical"],
  }),
  refund: question.probability("Is the customer explicitly asking for a refund?"),
}

export const decisionPayload = {
  model: "typesafe-ai/jev",
  answers: {
    category: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.8, technical: 0.2 },
    },
    impact: {
      type: "score",
      score: 1.5,
      probabilities: { "2": 0.5, "0": 0, "1": 0.5 },
      confidence: 0.5,
    },
    refund: { type: "boolean", probability: 0.9 },
  },
  usage: { inputTokens: 100, outputTokens: 25 },
  providerMetadata: {
    gateway: {
      cost: "0.0000042",
      generationId: "gen_test123",
      routing: { finalProvider: "typesafe-ai", canonicalSlug: "typesafe-ai/jev" },
    },
  },
}

export function decisionCatalog(input = "0.000000042") {
  return {
    data: [
      { id: "typesafe-ai/jev", type: "evaluation", name: "Jev", pricing: { input, output: "0" } },
    ],
  }
}

export function decisionRuntime(model: DecisionModel) {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: "gateway-decisions",
    ontology: [],
    models: { decision: [model] },
    storage,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
  })
  const sixb = createTestSixb(host)
  return {
    host,
    storage,
    sixb,
    identity: { projectId: host.id, executionId: sixb.execution.id },
  }
}
