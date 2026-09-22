# Generating responses

Generate text or validated structured data from a language model inside an action or workflow step.
[Configure a model](./overview.md#configure-a-model) before making calls.

## In a workflow

Use the step's `sixb` context to call a model. Supply instructions for how it should respond and a
prompt with the content to work on:

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

Add the step to a [workflow](../workflows/overview.md#define-a-workflow) with `.then(summarize)`.
You can also generate inside an action's [writeback or effects handler](../actions/overview.md#call-external-systems).
For a task that needs tools, use an [AI workflow step](../workflows/overview.md#add-an-ai-task).

## Structured output

Add an `output` schema to extract a typed result. Inside a step or action handler:

```ts
const { output } = await sixb.models.language.generate({
  prompt: input.document,
  output: {
    invoiceNumber: "string",
    amount: "decimal",
    currency: "string",
    overdue: "boolean",
  },
})

output.invoiceNumber // string
output.amount // Exact decimal string
output.overdue // boolean
```

Sixb validates the response against the schema. Invalid or incomplete output throws an error.
The selected model must support structured output.

## Choose a model

Generation uses the first model in `models.language`. To use another configured model, pass its
binding as `model`. You can also limit the response length with `maxOutputTokens`:

```ts
import { alternateModel } from "../../lib/models"

const { output } = await sixb.models.language.generate({
  model: alternateModel,
  prompt: input.document,
  maxOutputTokens: 1_000,
})
```

Here, `alternateModel` is a model binding exported from your project and included in
`models.language`. Provider-specific options are documented in the
[provider READMEs](./configuration.md).

## Usage

The result includes `usage`, `cost`, and `finishReason` alongside `output`. A text response that
reaches its token limit can be partial, with `finishReason` set to `"length"`.

Calls are recorded automatically and respect your [usage limits](./usage-and-limits.md).
