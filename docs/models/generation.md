# Generation

`sixb.models.language.generate()` makes one model call and awaits its accounting before returning.

## Text

```ts
const { output } = await sixb.models.language.generate({
  instructions: "Be concise. Use only facts in the document.",
  prompt: document,
})
// output: string
```

`instructions` is the system message. `prompt` is the user task or content.

## Structured output

Use the same Sixb schema records as workflow `.output()`. Sixb generates the provider schema and validates the response.

```ts
const { output } = await sixb.models.language.generate({
  prompt: document,
  output: {
    invoiceNumber: "string",
    amount: "decimal",
    currency: "string",
    overdue: "boolean",
  },
})

output.invoiceNumber // string
output.amount        // DecimalValue: an exact decimal string
output.overdue       // boolean
```

| Output schema | Result |
| --- | --- |
| Primitive schemas | Validated scalar values |
| Arrays, maps, objects | Recursively validated values |
| Value-type references | Resolved against the ontology |
| `date`, `timestamp` | Hydrated `Date` values |
| `decimal` | Canonical exact decimal strings |
| Object references | Validated `{ objectTypeId, primaryId }`; no object lookup |

Native structured-output support is required. Malformed, invalid, or incomplete output rejects; the call remains accounted for.

## Existing messages

Supply `messages` instead of `prompt`. Optional instructions are prepended; supplied messages keep their order.

```ts
const { output } = await sixb.models.language.generate({
  instructions: "Answer in one sentence.",
  messages: [
    { role: "user", content: [{ type: "text", text: "What is an ontology?" }] },
  ],
})
```

## Controls

```ts
import { alternateModel } from "../lib/models"

const result = await sixb.models.language.generate({
  model: alternateModel,
  prompt: document,
  maxOutputTokens: 1_000,
  reasoning: "medium",
  caching: "off",
  signal,
})
```

| Option | Default / behavior |
| --- | --- |
| `model` | First configured language model |
| `maxOutputTokens` | Resolved model limit, or 4,096 when unknown |
| `reasoning` | Provider default; named levels or `{ budgetTokens }` when supported |
| `caching` | Provider automatic behavior; `"off"` disables automatic prompt caching |
| `signal` | Combines with execution cancellation; cannot override it |

## Result

```ts
const { output, usage, cost, finishReason, callId } =
  await sixb.models.language.generate({ prompt: document })

if (finishReason === "length") {
  // The text reached its output ceiling.
}
```

| Field | Meaning |
| --- | --- |
| `output` | String, or the validated output record |
| `usage` | Available provider token counts; missing counts stay unknown |
| `cost` | Catalog-rated, provider-reported, or unpriceable |
| `finishReason` | Provider completion reason; structured output requires `stop` |
| `callId` | Unique identity of this inference call |

One invocation makes one inference request. There are no automatic retries, repairs, tools, or continuations.

| Outcome | Behavior |
| --- | --- |
| Text reaches its ceiling | Returns text with `finishReason: "length"` |
| Invalid or incomplete structured output | Throws `StructuredOutputError` |
| Provider error or content filtering | Rejects |
| Local tool call or pending continuation | Rejects |
| Cancellation | Rejects with the abort reason |
| Limit denial | Rejects before inference |
| Accounting persistence failure | Rejects and attempts durable recovery |

See [Usage and limits](./usage-and-limits.md) for accounting and recovery.

## In a workflow

Use an ordinary step for a single call. Use [`defineAgentStep()`](../workflows/overview.md#define-agent-tasks) when the task needs tools.

```ts
import { defineWorkflowStep } from "@sixb/core"

export const summarize = defineWorkflowStep("summarize")
  .input({ document: "string" })
  .output({ summary: "string" })
  .run(async ({ input, sixb }) => {
    const { output } = await sixb.models.language.generate({
      prompt: `Summarize this document:\n${input.document}`,
    })
    return { summary: output }
  })
```

## In an action

Generate in writeback, then use the persisted result in edits.

```ts
import { defineAction, param } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const summarizeInvoice = defineAction("summarize-invoice")
  .on(Invoice)
  .params({ document: param("string") })
  .writeback(async ({ params, sixb }) => {
    const { output } = await sixb.models.language.generate({
      prompt: params.document,
      output: { summary: "string" },
    })
    return output
  })
  .edits(({ objects, subject, writeback }) => {
    objects(Invoice).byId(subject.primaryId).update({ summary: writeback.summary })
  })
```

This example assumes `Invoice` has a `summary` string property. Effects handlers can also generate.

## Execution context

| Caller | Accounting owner |
| --- | --- |
| Action writeback/effects | Action execution |
| Ordinary workflow step | Workflow execution |
| Bound request | Request execution |
| `createTestSixb(host)` | Test request execution |

Generation uses the existing provider-access rules: ordinary principal-scoped requests cannot invoke providers directly. Worker calls retain their delivery attempt, cancellation, and admitted requester groups.
