# Models

Configure the AI models available to your project. Language models power conversations and
generation. Decision models classify inputs, score them against a rubric, and estimate probabilities.
Embedding models power semantic search. [Browse providers](#providers) for installation and credentials.

## Language models

Register the models you want to use in `models.language`. You can mix providers in the same
catalog. Export model bindings when you want to reuse them in your code:

File: `lib/models.ts`

```ts
import { anthropic } from "@sixb/anthropic"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const openaiModel = vercelGateway("openai/gpt-5.5")
export const anthropicModel = anthropic("claude-sonnet-5")
```

Add them to your existing project configuration:

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { anthropicModel, openaiModel } from "./lib/models"

export const sixb = createSixb({
  // ...your existing providers
  models: { language: [openaiModel, anthropicModel] },
})
```

The first language model is the default. Chat users can choose from this catalog and adjust the
reasoning effort their selected model supports. An [AI workflow step](../workflows/overview.md#add-an-ai-task)
can select a model and reasoning effort through its `model` and `reasoning` options.

## Generate a response

Use `sixb.models.language.generate()` inside an action or workflow step when your code supplies
the context for a model call. This step returns a summary of its input document:

File: `workflows/steps/summarize.ts`

```ts
import { defineWorkflowStep } from "@sixb/core"

export const summarize = defineWorkflowStep("summarize")
  .input({ document: "string" })
  .output({ summary: "string" })
  .run(async ({ input, sixb }) => {
    const { output } = await sixb.models.language.generate({
      instructions: "Summarize in one sentence. Use only facts in the document.",
      prompt: input.document,
    })

    return { summary: output }
  })
```

Add it to a [workflow](../workflows/overview.md#define-a-workflow) with `.then(summarize)`.
You can also generate inside an action's [writeback or effects handler](../actions/overview.md#call-external-systems).
Direct generation does not require a sandbox. For a task that needs tools, use an
[AI workflow step](../workflows/overview.md#add-an-ai-task).

### Model and response controls

Pass a configured model binding to override the default. Use `reasoning` to choose a supported
effort and `maxOutputTokens` to limit the response. Inside a step or action handler:

```ts
import { anthropicModel } from "../../lib/models"

const { output } = await sixb.models.language.generate({
  model: anthropicModel,
  prompt: input.document,
  reasoning: "high",
  maxOutputTokens: 1_000,
})
```

Available reasoning controls depend on the model and provider. See the [provider READMEs](#providers)
for supported options.

The result also includes `usage`, `cost`, and `finishReason`. Text cut short by the output limit
has `finishReason: "length"`. Calls are recorded and respect your [usage limits](./usage-and-limits.md).

## Structured output

Add an `output` schema to get a typed result. Inside a step or action handler:

```ts
const { output } = await sixb.models.language.generate({
  instructions: "Summarize the document and identify whether it requests a follow-up.",
  prompt: input.document,
  output: {
    summary: "string",
    requiresFollowUp: "boolean",
  },
})

output.summary // string
output.requiresFollowUp // boolean
```

Sixb validates the response against the schema. Invalid or incomplete output throws an error.
The selected model must support structured output.

## Decision models

Register a provider in `models.decision`. For example, install the TypeSafe provider and set
its credentials:

```bash
bun add @sixb/typesafe
export TYPESAFE_API_KEY="..."
```

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { typesafe } from "@sixb/typesafe"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    decision: [typesafe("jev-1.13.0")],
  },
})
```

The first decision model is the default. Decision models need neither a language model nor a sandbox.

### Define questions

Use `question.choice()` to select an option, `question.score()` to score against ordered levels,
and `question.probability()` for a yes/no probability. Questions can be reused across calls:

File: `lib/triage-questions.ts`

```ts
import { question } from "@sixb/core"

export const triageQuestions = {
  category: question.choice({
    instructions: "Identify the main issue in description.",
    options: {
      maintenance: "Breakdowns, leaks, and repairs",
      billing: "Invoices, payments, and refunds",
      other: "Any other request",
    },
  }),
  severity: question.score({
    instructions: "Assess the operational impact described in description.",
    levels: [
      "No operational impact",
      "Degraded operation; workaround available",
      "Operation stopped; no workaround",
    ],
  }),
  blocked: question.probability(
    "Does description explicitly report equipment that cannot operate?"
  ),
}
```

### Evaluate an input

Call `sixb.models.decision.evaluate()` inside an action's
[writeback or effects handler](../actions/overview.md#call-external-systems) or a workflow step:

```ts
import { triageQuestions } from "../../lib/triage-questions"

const { output } = await sixb.models.decision.evaluate({
  input: { description: "The cooling unit has stopped." },
  questions: triageQuestions,
})

output.category.choice // "maintenance" | "billing" | "other"
output.category.probabilities.maintenance // number from 0 to 1
output.severity.score // number from 0 to 2, possibly fractional
output.blocked.probability // number from 0 to 1
```

Scores are the expected level index, starting at zero. Use multiple probability questions when
several labels can apply to the same input. Validate thresholds on your application's data.
Calls are recorded and respect your [usage limits](./usage-and-limits.md).

For a workflow step, `decisionOutput()` derives the output schema from your questions:

File: `workflows/steps/triage.ts`

```ts
import { decisionOutput, defineWorkflowStep } from "@sixb/core"
import { triageQuestions } from "../../lib/triage-questions"

export const triage = defineWorkflowStep("triage")
  .input({ description: "string" })
  .output(decisionOutput(triageQuestions))
  .run(async ({ input, sixb }) => {
    const { output } = await sixb.models.decision.evaluate({
      input,
      questions: triageQuestions,
    })
    return output
  })
```

Add it to a [workflow](../workflows/overview.md#define-a-workflow) with `.then(triage)`.

## Embedding models

Embedding models turn text into vectors for [semantic search](../objects/querying.md#search-by-meaning).
Export an embedding model binding from your project:

File: `lib/models.ts`

```ts
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const productEmbedding = vercelGateway.embedding("openai/text-embedding-3-small", {
  dimensions: 1536,
})
```

Register it in `models.embedding` alongside any language models:

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { anthropicModel, openaiModel, productEmbedding } from "./lib/models"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    language: [openaiModel, anthropicModel],
    embedding: [productEmbedding],
  },
})
```

Reference the same binding in an object's [vector search profile](../ontology/properties.md#configure-vector-search).
Sixb uses it to index the object's text and embed search queries. Both operations count toward
[AI usage and limits](./usage-and-limits.md#embeddings).

An embeddings-only project needs neither a language model nor a sandbox.

## Providers

Each provider card opens its package README for installation, credentials, supported models,
and provider-specific options.

<div data-provider-library="models"></div>
