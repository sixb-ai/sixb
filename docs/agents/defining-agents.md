# Defining agents

Define an agent and export it from `agents/`. Sixb discovers it automatically.
The `id` is its stable identifier in routes and threads; it must be unique.

```ts
// agents/invoice-assistant.ts
import { defineAgent } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const invoiceAssistant = defineAgent("invoice-assistant", {
  name: "Invoice Assistant",
  description: "Tracks outstanding invoices, overdue accounts, and payment follow-ups.",
  model: vercelGateway("openai/gpt-5.5"),
  reasoning: "medium",
  instructions: [
    "You are this project's invoicing assistant.",
    "Focus on invoices, balances, due dates, and reminder status.",
    "Never claim a reminder was sent unless the data shows it.",
  ].join("\n"),
})
```

Providers share the same callable shape. To call Anthropic directly instead of routing through a
gateway:

```ts
import { anthropic } from "@sixb/anthropic"

export const supportAgent = defineAgent("support-agent", {
  name: "Support Agent",
  model: anthropic("claude-sonnet-5"),
  instructions: "Help customers using verified account and product information.",
})
```

## Config

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Display name shown in catalogs and pickers. |
| `model` | `LanguageModel` | Yes | A model returned by calling a provider. |
| `instructions` | `string` | Yes | The system prompt. |
| `description` | `string` | No | Short summary for catalogs. |
| `reasoning` | reasoning preference | No | `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `{ budgetTokens }`. |
| `groups` | `GroupDefinition[]` | No | Gate who can use the agent and what it can reach. See [Authorization](./authorization.md). |
| `tools` | `AgentToolDefinition[]` | No | Worker-side tools this agent is explicitly allowed to call. Defaults to none. |
| `loop` | `AgentLoopConfig` | No | Step cap, prompt caching, and optional context-budget overrides. |

## The model

`model` accepts a `LanguageModel` from `@sixb/core/models`. Provider packages construct models and
own their provider-specific configuration.
Vercel AI Gateway is callable directly:

```ts
import { vercelGateway } from "@sixb/vercel-ai-gateway"

model: vercelGateway("deepseek/deepseek-v4-flash")
model: vercelGateway("openai/gpt-5.5", {
  providerOptions: { gateway: { order: ["openai", "azure"] } },
})
```

To lower a model's output ceiling:

```ts
model: anthropic("claude-sonnet-4-5", { maxOutputTokens: 8_192 })
```

`maxOutputTokens` is optional for known models. It caps output; it does not target a response
length. The [context reserve](#loop-and-context-budget) and per-call limits can lower it further.

## Shared provider configuration

The default providers read their normal environment credentials lazily. For custom credentials,
headers, or other provider settings, create a provider and share it through imports:

```ts
// lib/models.ts
import { createAnthropic } from "@sixb/anthropic"

export const anthropic = createAnthropic({
  apiKey: () => process.env.SUPPORT_ANTHROPIC_KEY,
})

export const supportModel = anthropic("claude-sonnet-4-5")
```

```ts
// agents/support.ts
import { defineAgent } from "@sixb/core"
import { supportModel } from "../lib/models"

export const support = defineAgent("support", {
  name: "Support",
  model: supportModel,
  instructions: "Help customers using verified information.",
})
```

Models made by the same provider share its transport configuration and cached catalog.
Create another provider instance when another credential or configuration is needed.

## The project model catalog

A project can declare the models Sixb is allowed to use. The catalog is optional; when it is
present, every agent's `model` must be in it, and `createSixb()` fails at startup otherwise.

```ts
export const sixb = createSixb({
  // ...
  models: {
    language: [
      vercelGateway("openai/gpt-5.5"),
      vercelGateway("anthropic/claude-sonnet-4.6"),
    ],
  },
})
```

You can also reuse an imported model:

```ts
models: { language: [supportModel] }
```

- The **first entry** is the project default.
- Entries are identified by **`providerId/modelId`**; duplicates fail startup.
- Direct and Gateway access to the same vendor model are separate entries: they route and bill
  differently.

## Reasoning

Reasoning is one normalized preference, not a boolean. Named efforts are the portable default:

```ts
reasoning: "high"
```

Providers that expose an exact native budget can also accept a token budget:

```ts
model: anthropic("claude-sonnet-4", { maxOutputTokens: 16_384 })
reasoning: { budgetTokens: 8_192 }
```

Providers reject known unsupported preferences before making a network request.

| `model.definition.capabilities.reasoning` | Meaning |
| --- | --- |
| An object | Supported efforts, disable support, and exact token-budget bounds. |
| `undefined` | The current definition does not know. |
| `false` | Reasoning is known to be unsupported. |

## Instructions vs Agent Skills

| Put in `instructions` | Put in Agent Skills |
| --- | --- |
| Role, behavioral rules, domain boundaries | Company standards, examples, templates, procedures |
| Included in every request | Full content read when relevant |

```txt
skills/acme-writing-style/SKILL.md
skills/acme-writing-style/references/examples.md
```

Project skills are installed into each run sandbox under `$SIXB_SKILLS_DIR`. The worker advertises
only each skill's `name` and `description` up front, and the agent reads the full `SKILL.md` when the
skill is relevant.

## Tools

`tools` is an explicit per-agent capability grant:

```ts
export const researcher = defineAgent("researcher", {
  name: "Researcher",
  model: vercelGateway("openai/gpt-5.5"),
  instructions: "Research approved sources and cite them.",
  tools: [webSearch, webFetch],
})
```

Omitting it gives the agent no selected worker tools. Sixb still supplies sandboxed `read` and
`bash`. See [Tools and gateway](./tools-and-gateway.md) for custom tools and Exa web access.

## Loop and context budget

Each loop step makes one model call. The default limit is **100 steps**.

```text
Call model --> Final answer --> Done
    |
    +--> Tool calls --> Execute tools --> Results --> Next step
```

```ts
loop: { stopWhen: { maxSteps: 12 } }
```

### Prompt caching

Gateway automatic prompt caching is enabled by default. Cache reads and writes appear in AI usage.
To opt out:

```ts
loop: { caching: "off" }
```

Direct-provider models retain their provider-specific caching behavior.

### Context preparation

Before a conversational run's model loop, Sixb checks whether the context fits:

```text
System prompt + tools + summary + recent history + current message
                              |
                       Estimate input size
                              |
                      Fits input budget?
                       /             \
                     yes              no
                      |                |
                      |       Summarize older complete turns
                      |       Keep recent turns + current message
                      |       Check fit; save checkpoint
                      |                |
                      +-------+--------+
                              v
                       Start model loop
```

The estimate includes the request shape and, when suitable, prior provider token usage.
Compaction changes only the model-facing view; the full transcript stays intact. If the summary
and recent turns still cannot fit, the run fails. This check happens at run preflight, not at every
loop step.

### Context overrides

Omit `loop.context` to use automatic compaction with default budgets. Override it for a specific
deployment or workload:

```ts
loop: {
  stopWhen: { maxSteps: 12 },
  caching: "auto",
  context: {
    windowTokens: 200_000,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
  },
}
```

```text
Context window
+-----------------------------------+------------------+
| Input: prompt + tools + history   | Output reserve   |
+-----------------------------------+------------------+
```

| Optional field | Default |
| --- | --- |
| `windowTokens` | Model `contextWindow`, then `maxInputTokens`, then 128,000. An explicit value overrides model input limits. |
| `reserveTokens` | Smaller of 16,384 or 25% of the window; increased to exceed an exact reasoning budget. |
| `keepRecentTokens` | Smaller of 20,000 or half the input budget. |

The input budget is **window minus reserve**, also capped by the model's `maxInputTokens` unless
`windowTokens` is explicitly set. An input-only model limit is treated as a conservative window.
Generation is capped by both the reserve and the model's output ceiling; an explicit reserve must
accommodate reasoning.

### How model limits are resolved

| At worker startup | Behavior |
| --- | --- |
| Explicit window or known local limits | Prepare an offline model snapshot. |
| Limits need discovery | Resolve through the provider's cached catalog. |
| Catalog transport/access failure | Use an offline snapshot. |
| No context limit available | Use 128,000 tokens and warn once per model. |
| Invalid definition, identity mismatch, or other resolver error | Fail startup. |

Execution, capabilities, output limits, and compaction use the same prepared snapshot. Restart the
worker to pick up catalog changes. Set `loop.context.windowTokens` if the fallback does not match
your deployment.

Custom models can implement `resolve({ offline })`. It must preserve provider/model identity, pin
operational metadata, and avoid network lookup when `offline` is true. Signal catalog access
failures with `ModelCatalogUnavailableError` from `@sixb/core/models`.

## Usage and costs

**Accounting happens after each model call, before the next billable step** — including calls that
generate compaction summaries.

```text
Model call finishes
        |
Normalize usage + compute local estimate
        |
Provider reported a charge?
        |
        +-- yes --> Select reported cost; keep estimate too
        |
        +-- no ---> Select estimate or "unpriceable"
        |
        v
Store usage + selected cost
```

The model integration's optional `costEstimator` prices **returned token usage**, independently of
context limits and preflight token estimates. It runs for completed calls even when a provider
charge is available. Local rates require no administrative credentials or financial API requests.

### What gets stored

| Selected cost | Stored status | `priceSource.sourceId` | Detail |
| --- | --- | --- | --- |
| Provider-reported charge | `rated` | `provider-reported` | Local estimate retained alongside it. |
| Local estimate | `rated` | `model-rate-card` | Token quantities, rates, and charge components. |
| Cannot price | `unpriceable` | — | Reason and available missing-meter diagnostics. |

Both priced paths use the same money format: USD, with billionths of a dollar stored as an integer
string.

```jsonc
{ "currency": "USD", "amountNanos": "1250000" } // $0.00125
```

- **Atlas totals count each call once.** A retained estimate appears alongside the reported charge
  and is not added to it.
- **Provider-reported means a charge was supplied**, not just a response. Gateway charges describe
  Gateway billing; they are not independently verified invoice totals.
- **Usage and cost are saved atomically.** Storage recovery deduplicates replays.
- **Unknown is never zero.** Invalid estimates preserve valid usage and reported charges. Accepted
  streams interrupted before final usage retain unknown meters/cost and any native IDs received.

Use `storage.aiCosts.listModelCalls()` to read immutable call-time costs and optional estimates.
Provider request, response, and generation IDs appear in the model-call API and Atlas when supplied;
internal fallback response IDs are separate.

This is a call-level ledger: requests that fail before returning a stream and process crashes before
recording are outside its guarantee.

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
- [Tools and gateway](./tools-and-gateway.md) — selected worker tools plus sandboxed `read` and
  `bash`.
- [Running and streaming](./running-and-streaming.md) — drive a defined agent.
- [Runtime](../runtime/overview.md) and [project structure](../fundamentals/project-structure.md).
