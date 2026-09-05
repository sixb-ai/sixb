# Configure the Agent

Sixb provides one conversational Agent. Configure its capabilities on the project, not a separate
agent definition.

To lower a model's output ceiling:

```ts
import { anthropic } from "@sixb/anthropic"

const model = anthropic("claude-sonnet-4-5", { maxOutputTokens: 8_192 })
```

`maxOutputTokens` is optional for known models. It caps output; it does not target a response
length. The automatic context reserve and per-call limits can lower it further.

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
// sixb.config.ts
import { createSixb } from "@sixb/core"
import { supportModel } from "./lib/models"

export const sixb = createSixb({
  // ...storage, broker, queues, sandboxes
  models: { language: [supportModel] },
})
```

Models made by the same provider share its transport configuration and cached catalog.
Create another provider instance when another credential or configuration is needed.

## The project model catalog

```ts
import { createSixb } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"
import { searchKnowledge } from "./ai/tools"

export const sixb = createSixb({
  // ...storage, broker, queues, sandboxes
  models: {
    language: [
      vercelGateway("openai/gpt-5.5"),
      vercelGateway("anthropic/claude-sonnet-4.6"),
    ],
  },
  tools: [searchKnowledge],
})
```

| Configuration | Behavior |
| --- | --- |
| `models.language` | Sixb language model bindings the Agent and its children may use. The first is the default. |
| `tools` | Reusable `defineAgentTool` definitions available to the Agent and its children. |
| `sandboxes` | Sandbox factory used for isolated file and CLI access on each run. |
| `skills/` | Project instructions, procedures, and references loaded when relevant. |

The model's `{ provider, modelId }` pair identifies its binding; no additional id is needed. Two
bindings for the same vendor model may coexist (for example Gateway and a direct provider), but
duplicate pairs are rejected.

The composer lets users choose the model and reasoning for each turn. Without a selection, Sixb
uses the first language model and the provider's default reasoning. It does not automatically route
simple messages to a smaller model.

Provider definitions supply capabilities, context limits, and supported reasoning levels. The
runtime accepts named reasoning levels or an exact `{ budgetTokens }` budget when supported;
the composer offers the named levels. Unknown capabilities are not treated as unsupported.

## Instructions and tools

Sixb owns the conversational baseline prompt and sandbox guidance. Put domain-specific procedures
in Agent Skills, for example `skills/invoice-review/SKILL.md`. Only skill names and descriptions are
advertised up front; the Agent reads the full instructions when needed.

Omitting `tools` removes project-defined tools, not the framework's sandbox tools or authorized Sixb
CLI. Permissions still control access to project data. See [Tools and gateway](./tools-and-gateway.md)
and [Authorization](./authorization.md).

Workflow tasks use `defineAgentStep` with their own prompt, optional model, selected tools, and
execution groups. They are not additional chat agents. See [Agent steps](../workflows/overview.md).

## Conversation limits

The worker defaults to 100 model steps per turn and a 10-minute timeout. At the step limit, it asks
for a final answer without further tools; a later user message starts a new turn. Prompt caching
uses the provider's automatic behavior.

Long conversations are compacted using the selected model's provider metadata. Missing context
limits use a 128,000-token fallback with a warning. The runtime reserves output space and respects
the model's input/output caps and reasoning budget. The full transcript is preserved; only model
input becomes a summary plus recent turns.

Switching models does not bypass these limits: the worker estimates both the summary request and
the continuation, including tools, before making the summary call, then checks the generated
continuation again. If the selected model is too small, the run fails without replacing the stored
history. Select a larger model or start a new conversation; Sixb never switches models for you.

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

The optional `costEstimator.estimateReservation({ inputTokens, outputTokens })` estimates token
cost before a provider call. It returns USD nanounits, or `undefined` when the configured model
cannot be priced safely. Built-in providers use the highest applicable cache and tier rates.
Custom integrations can reuse `estimateModelReservation` with their rate card. A cost limit
requires this capability; token limits do not. Input tokens and the output allowance remain
estimates, so this admission check is not a hard ceiling on the final provider charge.

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

## Upgrading from defined agents

- Replace `defineAgent` and `createSixb({ agents })` with project `models` and `tools`.
- Move reusable instructions into `skills/`; `agents/` is no longer discovered.
- Use `sixb.agent` and `GET /api/agent`.
- Existing conversation history is preserved without its former Agent identity.

## Related

- [Running and streaming](./running-and-streaming.md)
- [Tools and gateway](./tools-and-gateway.md)
- [Authorization](./authorization.md)
