import { expect, test } from "bun:test"
import { question } from "@sixb/core"
import { DecisionModelResponseError } from "@sixb/core/models"
import { systemOneRequest, systemOneResult } from "../src/systemone"

const questions = {
  team: question.choice({
    instructions: "Which team handles this ticket?",
    options: { billing: "Invoices and refunds", support: { area: "product" }, sales: null },
  }),
  urgency: question.score({
    instructions: "How urgent is it?",
    levels: ["not urgent", "somewhat", "urgent", "critical"],
  }),
  defect: question.probability("Is this a software defect?"),
}

// Microsoft-Decision-1's answer to these questions, as Azure returned it on 2026-11-13.
const body = {
  model: "microsoft-decision-1",
  answers: {
    team: {
      type: "choice",
      choice: "billing",
      confidence: 0.9998627473242303,
      probabilities: {
        billing: 0.9999084982161535,
        sales: 0.000040061631178872915,
        support: 0.00005144015266764291,
      },
    },
    urgency: {
      type: "score",
      score: 2.8698165328211824,
      confidence: 0.8349322515916855,
      legend: { "0": "not urgent", "1": "somewhat", "2": "urgent", "3": "critical" },
      probabilities: {
        "0": 0.0011625240758242734,
        "1": 0.004057607720933089,
        "2": 0.11858067950947852,
        "3": 0.8761991886937641,
      },
    },
    defect: { type: "noul", noul: 0.9953904278444986 },
  },
  usage: { input_tokens: 63, output_tokens: 3 },
}
const options = { providerId: "provider", modelId: "deployment", errorPrefix: "[Test]" }

test("serializes all three question types, with probability as noul", () => {
  expect(systemOneRequest("deployment", { input: { ticket: "Refund?" }, questions })).toEqual({
    model: "deployment",
    state: { ticket: "Refund?" },
    questions: {
      team: {
        type: "choice",
        instructions: "Which team handles this ticket?",
        criteria: { billing: "Invoices and refunds", support: { area: "product" }, sales: null },
      },
      urgency: {
        type: "score",
        instructions: "How urgent is it?",
        criteria: ["not urgent", "somewhat", "urgent", "critical"],
      },
      defect: { type: "noul", instructions: "Is this a software defect?" },
    },
  })
})

test("keeps question names as data, including __proto__", () => {
  const named = JSON.parse('{"__proto__": {"type": "probability", "instructions": "Spam?"}}')
  const request = systemOneRequest("m", { input: "x", questions: named })
  expect(Object.keys(request.questions)).toEqual(["__proto__"])
  expect(JSON.parse(JSON.stringify(request)).questions.__proto__).toEqual({
    type: "noul",
    instructions: "Spam?",
  })
})

test("decodes answers in Sixb's shape and keeps usage, model and request ID", () => {
  const result = systemOneResult(body, questions, {
    ...options,
    requestId: "request-1",
    redact: (value) => value.toUpperCase(),
  })
  expect(result).toEqual({
    output: {
      team: {
        choice: "billing",
        confidence: body.answers.team.confidence,
        probabilities: body.answers.team.probabilities,
      },
      urgency: {
        score: body.answers.urgency.score,
        confidence: body.answers.urgency.confidence,
        probabilities: Object.values(body.answers.urgency.probabilities),
      },
      defect: { probability: body.answers.defect.noul },
    },
    usage: { inputTokens: 63, outputTokens: 3 },
    responseModelId: "MICROSOFT-DECISION-1",
    providerIds: { requestId: "request-1" },
  })
})

test.each([
  ["a missing answer", { ...body.answers, defect: undefined }],
  ["an extra answer", { ...body.answers, extra: body.answers.defect }],
  ["a wrong answer type", { ...body.answers, defect: { type: "choice", noul: 0.5 } }],
  [
    "a missing score level",
    { ...body.answers, urgency: { ...body.answers.urgency, probabilities: { "0": 1 } } },
  ],
  ["a non-numeric probability", { ...body.answers, defect: { type: "noul", noul: "high" } }],
])("rejects %s but keeps the billable usage", (_, answers) => {
  const error = (() => {
    try {
      return systemOneResult({ ...body, answers }, questions, options)
    } catch (error) {
      return error
    }
  })()
  expect(error).toBeInstanceOf(DecisionModelResponseError)
  expect(error).toMatchObject({
    message: "[Test] Invalid decision response.",
    providerId: "provider",
    modelId: "deployment",
    metadata: { usage: { inputTokens: 63, outputTokens: 3 } },
  })
})

test("a provider's model rule rejects the answers, and missing usage stays unknown", () => {
  // Removal proof: drop the assertModel call in systemOneResult; the answers come back.
  expect(() =>
    systemOneResult({ model: "other", answers: body.answers }, questions, {
      ...options,
      assertModel: (model) => {
        if (model !== "microsoft-decision-1") throw new Error("Unexpected model")
      },
    })
  ).toThrow(DecisionModelResponseError)
  expect(systemOneResult({ answers: body.answers }, questions, options).usage).toEqual({})
})
