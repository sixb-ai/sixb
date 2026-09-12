# Models

Configure language models once. Call them from application code, workflow steps, or Sixb's built-in Agent.

## Configure

Add models to your existing project configuration. The first is the default.

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    language: [vercelGateway("openai/gpt-5.5")],
  },
})
```

## Generate

Inside an action's writeback/effects handler or a workflow step:

```ts
const { output } = await sixb.models.language.generate({
  prompt: "Summarize this invoice in one sentence: ...",
})
// output: string
```

Add an output shape for a validated, typed result:

```ts
const { output } = await sixb.models.language.generate({
  prompt: "Extract the invoice details: ...",
  output: {
    invoiceNumber: "string",
    amount: "decimal",
    currency: "string",
  },
})

output.invoiceNumber // string
output.amount        // DecimalValue
output.currency      // string
```

Usage, cost, and limits are handled automatically.

## Choose the API

| Need | Use |
| --- | --- |
| One text or structured response | [`sixb.models.language.generate()`](./generation.md) |
| A model call within a business process | An ordinary [workflow step](../workflows/overview.md) calling `generate()` |
| A workflow task that uses tools | [`defineAgentStep()`](../workflows/overview.md#define-agent-tasks) |
| A conversation with tools and streaming | The [built-in Agent](./built-in-agent.md) |

## Next

| Page | Covers |
| --- | --- |
| [Configuration](./configuration.md) | Providers, credentials, defaults, model selection |
| [Generation](./generation.md) | Text, structured output, controls, action/workflow examples |
| [Usage and limits](./usage-and-limits.md) | Accounting, monthly budgets, permissions |
| [Built-in Agent](./built-in-agent.md) | Threads, runs, streaming, chat UI |
| [Tools and Authorization](./tools-and-authorization.md) | Custom tools, skills, sandbox access, grants |
