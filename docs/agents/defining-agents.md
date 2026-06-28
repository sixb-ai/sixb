# Defining agents

`defineAgent(id, config)` creates an agent. The `id` is its stable identifier (used in routes and
threads) and must be unique across all agents. The call validates the config and returns an
`AgentDefinition` you export from `agents/`.

```ts
// agents/invoice-assistant.ts
import { defineAgent } from "@sixb/core"
import { gateway } from "ai"

export const invoiceAssistant = defineAgent("invoice-assistant", {
  name: "Invoice Assistant",
  description: "Tracks outstanding invoices, overdue accounts, and payment follow-ups.",
  model: gateway("openai/gpt-5.5"),
  reasoning: "medium",
  instructions: [
    "You are this project's invoicing assistant.",
    "Focus on invoices, balances, due dates, and reminder status.",
    "Never claim a reminder was sent unless the data shows it.",
  ].join("\n"),
  providerOptions: {
    openai: { reasoningSummary: "detailed" },
  },
})
```

## Config

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Display name shown in catalogs and pickers. |
| `model` | `LanguageModelV4` | Yes | An AI SDK model instance (see below). |
| `instructions` | `string` | Yes | The system prompt. |
| `description` | `string` | No | Short summary for catalogs. |
| `reasoning` | reasoning level | No | `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `providerOptions` | provider-keyed object | No | Per-provider passthrough, e.g. `{ openai: { ... } }`. |
| `groups` | `GroupDefinition[]` | No | Gate who can use the agent and what it can reach. See [Authorization](./authorization.md). |
| `loop` | `{ stopWhen?: { maxSteps?: number } }` | No | Step cap per turn. Defaults to **25**. |

## The model

`model` is an [AI SDK](https://sdk.vercel.ai) `LanguageModelV4` instance, not a string. The simplest
source is the `ai` gateway; any provider that returns a `LanguageModelV4` works.

```ts
import { gateway } from "ai"

model: gateway("deepseek/deepseek-v4-flash")
model: gateway("openai/gpt-5.5")
```

## Loop

An agent runs a tool-calling loop: the model produces output, may call tools, sees the results, and
continues until it stops or hits `loop.stopWhen.maxSteps` (default 25).

```ts
loop: { stopWhen: { maxSteps: 12 } }
```

## Discovery

`createSixb()` discovers exported agents from `agents/` automatically. To register one explicitly,
pass it as well — the lists merge, and duplicate ids are rejected:

```ts
import { createSixb } from "@sixb/core"
import { businessAnalyst } from "./agents/business-analyst"

export const sixb = createSixb({
  id: "acme-corp",
  agents: [businessAnalyst], // merged with discovered agents/ exports
  // ...
})
```

## Related

- [Authorization](./authorization.md) — `groups` and what they gate.
- [Running and streaming](./running-and-streaming.md) — drive a defined agent.
- [Runtime](../runtime/overview.md) and [project structure](../fundamentals/project-structure.md).
