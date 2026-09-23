import { decisionOutput, defineWorkflowStep, type InferStepOutput, question } from "../src"
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

// Removal proof: restore Extract<keyof Options, string> in either result or schema types.
// Exact equality catches never as well as widening to string.
type Expect<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const numericQuestions = {
  numeric: question.choice({ instructions: "Topic?", options: { 1: "Repair", 2: "Billing" } }),
  mixed: question.choice({ instructions: "Topic?", options: { 1: "Repair", other: "Other" } }),
  text: questions.topic,
}
const numericResult = await models.evaluate({ input: "Broken", questions: numericQuestions })
type _numericChoice = Expect<Equal<typeof numericResult.output.numeric.choice, "1" | "2">>
type _mixedChoice = Expect<Equal<typeof numericResult.output.mixed.choice, "1" | "other">>
type _textChoice = Expect<Equal<typeof numericResult.output.text.choice, "billing" | "repair">>

const numericStep = defineWorkflowStep("numeric-triage")
  .input({ text: "string" })
  .output(decisionOutput(numericQuestions))
  .run(
    async ({ input, sixb }) =>
      (await sixb.models.decision.evaluate({ input, questions: numericQuestions })).output
  )
type NumericStepOutput = InferStepOutput<typeof numericStep>
type _numericWorkflowChoice = Expect<Equal<NumericStepOutput["numeric"]["choice"], "1" | "2">>
type _mixedWorkflowChoice = Expect<Equal<NumericStepOutput["mixed"]["choice"], "1" | "other">>
type _textWorkflowChoice = Expect<Equal<NumericStepOutput["text"]["choice"], "billing" | "repair">>
