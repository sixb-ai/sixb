import { decisionOutput, defineWorkflowStep, question } from "../src"
import type { DecisionModelResult, DecisionModelsRuntime, LanguageModel } from "../src/models"

declare const models: DecisionModelsRuntime
declare const language: LanguageModel
const questions = {
  topic: question.choice({
    instructions: "Topic?",
    options: { billing: "Payments", repair: "Repairs" },
  }),
  impact: question.score({ instructions: "Impact?", levels: ["None", "Blocked"] }),
  urgent: question.probability("Urgent?"),
}
const result = await models.evaluate({ input: { description: "Broken" }, questions })
const topic: "billing" | "repair" = result.output.topic.choice
const probability: number = result.output.urgent.probability
const score: number = result.output.impact.score
// @ts-expect-error Undeclared choice.
const invalid: "sales" = result.output.topic.choice
// @ts-expect-error A probability is not a boolean.
const boolean: boolean = result.output.urgent.probability
// @ts-expect-error Unknown answer.
result.output.missing
// @ts-expect-error Unknown option.
result.output.topic.probabilities.sales
// @ts-expect-error A language model cannot satisfy the decision contract.
await models.evaluate({ model: language, input: "", questions })
// @ts-expect-error At least two described levels.
question.score({ instructions: "Impact?", levels: ["Only"] })
const step = defineWorkflowStep("triage")
  .input({ text: "string" })
  .output(decisionOutput(questions))
  .run(
    async ({ input, sixb }) => (await sixb.models.decision.evaluate({ input, questions })).output
  )
void [topic, probability, score, invalid, boolean, step]

// Removal proof: restore DecisionModelResult.output to unknown; the four errors below disappear.
const providerResult: DecisionModelResult = {
  output: {
    topic: { choice: "billing", probabilities: { billing: 0.8, repair: 0.2 } },
    impact: { score: 0.25, probabilities: [0.75, 0.25] },
    urgent: { probability: 0.9 },
  },
}
const invalidProviderText: DecisionModelResult = {
  // @ts-expect-error Providers return a map of decoded answers, not raw text.
  output: "billing",
}
const invalidProviderChoice: DecisionModelResult = {
  // @ts-expect-error A choice must include its probability distribution.
  output: { topic: { choice: "billing" } },
}
const invalidProviderProbability: DecisionModelResult = {
  // @ts-expect-error A provider probability must be numeric.
  output: { urgent: { probability: true } },
}
declare const wireResponse: unknown
const undecodedProviderResponse: DecisionModelResult = {
  // @ts-expect-error Unknown wire data must be decoded before returning it.
  output: wireResponse,
}
void [
  providerResult,
  invalidProviderText,
  invalidProviderChoice,
  invalidProviderProbability,
  undecodedProviderResponse,
]
