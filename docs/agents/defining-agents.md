# Defining agents

`defineAgent(id, config)` creates an agent. The `id` is its stable identifier (used in routes and
threads) and must be unique across all agents. The call validates the config and returns an
`AgentDefinition` you export from `agents/`.

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

`maxOutputTokens` is optional for known models. Providers supply the default output ceiling;
set it when you want a lower cap. It limits output rather than targeting a response length.
Per-call limits, including compaction summary limits, can lower that ceiling.

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

The first entry is the project default. Entries are `LanguageModel`s, identified by
`providerId/modelId`. Duplicate entries fail startup. You can reuse an imported model:

```ts
models: { language: [supportModel] }
```

An entry is the binding, not only the vendor model: the same vendor model reached through Vercel AI
Gateway and through a direct provider are distinct entries because they route and bill differently.
An agent's `model` has to match one of the configured entries.

Reasoning is one normalized preference, not a boolean. Named efforts are the portable default:

```ts
reasoning: "high"
```

Providers that expose an exact native budget can also accept a token budget:

```ts
model: anthropic("claude-sonnet-4", { maxOutputTokens: 16_384 })
reasoning: { budgetTokens: 8_192 }
```

`model.definition.capabilities.reasoning` describes the controls known for that concrete provider
offering: whether reasoning can be disabled, its supported named efforts, and any exact token-budget
bounds. `undefined` means the synchronous model definition does not know; `false` means the catalog
knows reasoning is unsupported. Providers reject a known unsupported preference before making the
network request rather than silently approximating it.

## Instructions vs Agent Skills

Keep `instructions` short and always relevant: the agent role, hard behavioral rules, and domain
boundaries. Put larger company standards, examples, templates, and repeatable procedures in Agent
Skills instead:

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

An agent runs a tool-calling loop: the model produces output, may call tools, sees the results, and
continues until it stops or hits `loop.stopWhen.maxSteps` (default 25).

```ts
loop: { stopWhen: { maxSteps: 12 } }
```

For Gateway models, Sixb enables the Gateway's automatic prompt caching by default and records
cache reads and writes in AI usage. Provider details stay out of project prompts and
`providerOptions`. Opt out only when the workload requires it:

```ts
loop: { caching: "off" }
```

Direct-provider models retain their provider-specific caching behavior.

Sixb automatically checkpoints long conversations before their next model request exceeds the
selected model's context window. At startup, the worker uses locally available model limits or
calls the model's `resolve()` to fetch metadata through its provider's cached catalog and retain
an executable snapshot. Execution, media/reasoning capabilities, per-call output limits, and
compaction then use that same snapshot. An explicit `loop.context.windowTokens` avoids that lookup
and allows offline startup. Known local limits also use an offline snapshot. Refreshing a provider
catalog does not change a running worker's prepared models; restart the worker to resolve again.
Custom models may implement `resolve({ offline })`; it must preserve provider and model identity,
pin operational metadata, and avoid network lookup when `offline` is true. The older
`resolveDefinition()` hook remains supported with a bound stream and resolved output ceiling.
If no limit is available, startup fails with instructions to configure a window or supply a model
definition; Sixb does not assume a default context size.

Model definitions distinguish `contextWindow` (shared input/output capacity) from `maxInputTokens`.
When both are known, the input budget respects both limits. When only an input limit is known,
Sixb uses it as a conservative window and still leaves the configured output reserve.

The full transcript remains unchanged. Only the model-facing view becomes a continuation summary
plus recent complete turns.

Use `loop.context` only when a model deployment or workload needs an explicit override:

```ts
loop: {
  stopWhen: { maxSteps: 12 },
  caching: "auto",
  context: {
    windowTokens: 200_000,
  },
}
```

`windowTokens` overrides the catalog and is authoritative when set. `reserveTokens` defaults to the
smaller of 16,384 or 25% of the resolved window. `keepRecentTokens` defaults to the smaller of
20,000 or half the resolved input budget. All three fields are optional; omitting `context` keeps
automatic compaction enabled with model-derived defaults.

## Usage and costs

Sixb records completed model calls, including compaction summaries, before another billable step
starts. Token estimates come from the model integration's optional `costTracking`, independently
of operational metadata such as context limits. Inline provider costs are retained separately.

Atlas displays a **selected cost** for each call: an inline provider cost when available, otherwise
a local estimate, otherwise unknown. When both are available, the local estimate appears alongside
the provider cost. Totals count each call once. Gateway charges describe Gateway billing.

Usage and cost are recorded atomically and recovered idempotently after a storage failure.
`storage.aiCosts.listModelCalls()` returns the immutable call-time cost and its optional estimate.
Native request, response, and generation IDs are retained when supplied by the provider and exposed
through the model-call API and Atlas. Internal fallback response IDs are stored separately.

Storage migration `029-model-accounting` adds requested reasoning and native provider IDs, and
updates the historical missing-price reason while preserving existing valuations. Estimates use
local provider rates and require no administrative credentials or financial API requests.

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
