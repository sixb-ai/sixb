# Models

Configure the AI models available to your project. Language models power conversations and
generation. Embedding models power semantic search. [Browse providers](#providers) for
installation and credentials.

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
