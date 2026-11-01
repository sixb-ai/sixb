# @sixb/anthropic

Per-call `maxOutputTokens` limits (including compaction summaries) can lower, but never raise,
the output ceiling configured on the model.

Callable Anthropic provider for Sixb's core model contract. It uses the native Messages API and a
small provider-owned rate card for explicitly covered Anthropic model versions. Current model metadata and
limits are available through the catalog API and the model returned by `await model.resolve?.()`.
The resolver uses the shared, cached provider catalog, preserves configured definitions and binding
options, and does not mutate `model.definition`. Anthropic's `max_input_tokens` is exposed as
`maxInputTokens`, not as a shared input/output context window. Agent workers resolve missing limits
at startup; an explicit `loop.context.windowTokens` or locally supplied limit avoids network access.

Messages serialization, SSE streaming, usage normalization, and signed/opaque block replay use
Sixb's internal `@sixb/model-protocols/messages` implementation. Anthropic owns credentials,
catalog metadata, model-specific thinking and schema policy, request options, and rate cards.
Thinking signatures are assembled across all signature deltas before being stored for replay.

```ts
import { anthropic } from "@sixb/anthropic"

const model = anthropic("claude-sonnet-5")
```

`anthropic` reads `ANTHROPIC_API_KEY` lazily, and `ANTHROPIC_WORKSPACE_ID` for keys that are not
scoped to a single workspace, which Anthropic otherwise rejects. Create an isolated provider when you need custom
credentials, headers, beta features, transport, or inline definitions:

```ts
import { createAnthropic } from "@sixb/anthropic"

const provider = createAnthropic({
  apiKey: () => process.env.MY_ANTHROPIC_KEY,
  betas: ["example-beta"],
})

const model = provider("claude-opus-5", {
  reasoning: "high",
  maxOutputTokens: 16_384,
  request: {
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
})

const definitions = await provider.catalog.list()
```

## Prompt caching

Anthropic caches only what a request marks, so the adapter marks the prefixes Sixb repeats, with no
configuration:

| Breakpoint | Reused by |
| --- | --- |
| Last local tool | Every thread and user of the project: tools render first |
| Last system block | Later turns of a thread, even when replayed history differs |
| Conversation tail (automatic caching) | The next agent step, which only appends |

One-shot requests, with no tools and no earlier answer, such as `generate()`, stay uncached:
nothing reads their prefix again, and a cache write costs 1.25x input. A compaction summary
continues its conversation's cached request, so it reads that cache and keeps its lifetime. Pass
`caching: "auto"` to cache a one-shot request anyway, or `caching: "off"` to send no breakpoints.
Agent steps keep the five-minute TTL, except a chat turn's, and a sub-agent's that can wait on an
approval: their next read can come after a human pause, so their breakpoints ask for an hour (a
one-hour write costs 2x input, and only what the step adds is written). A `cache_control` in the binding's `request`, as above, sets the TTL for every
breakpoint, since Anthropic requires longer TTLs first.

`reasoning` is the level Sixb applies when the model runs without an explicit choice; Sixb checks
it against the model's capabilities at startup. `name` and `description` replace the catalog's
own in the chat's model picker and in the delegation guide of `spawn_agent`. Share the configured
provider or model through normal imports. Agents accept the returned
`LanguageModel` directly. An optional project catalog uses `models: { language: [model] }`.

`await model.resolve?.()` returns an executable metadata snapshot from the effective catalog.
Workers retain it for both generation and compaction. `{ offline: true }` pins locally available
metadata without fetching; workers use it with explicit context overrides or known local limits.
Resolved bindings never consult the catalog again for capabilities. Unresolved direct bindings
retain the structured-output discovery behavior below.

Catalog transport/access failures throw `ModelCatalogUnavailableError` from `@sixb/core/models`,
with the original error retained as `cause`. Workers recover using an offline snapshot and, if no
context limit is available, a 128,000-token fallback with a warning. Malformed metadata still fails.

`maxOutputTokens` is optional. Anthropic requires `max_tokens` on every Messages request, so the
adapter resolves an omitted value to the selected Claude model's provider-owned output limit (128K,
64K, or the appropriate legacy limit). An explicit value lowers that ceiling, for agents too.
Unknown non-Claude models require an explicit value; inference never fetches the catalog to
discover one.

Structured output uses Anthropic's native `output_config.format` when the model catalog confirms
support and the schema fits the native decoder. Otherwise the adapter throws
`UnsupportedModelFeatureError` before inference. There is no JSON-tool fallback.
Sixb validates the completed value against the original application contract and rejects
truncated or refused output, even when its text is valid JSON. Native output preserves manual
thinking when the model supports it.

Local tools use the same schema transformation as native structured output: unsupported decoder
constraints move into descriptions, while Sixb validates inputs against the original tool contract.
Schemas with open objects are sent unchanged with `strict: false` to preserve their allowed keys.
References retain their sibling `$defs` and `definitions`, with those definitions sanitized by the
same rules. An open object behind a reference also selects the non-strict fallback.

Native server tools can be supplied beside Sixb's local tools:

```ts
const model = anthropic("claude-sonnet-5", {
  providerTools: [{ type: "web_search_20260209", name: "web_search" }],
})
```

Agent and model-loop reasoning uses the shared provider-neutral preference. Anthropic named efforts
map to `output_config.effort` and enable adaptive thinking on Claude Sonnet 4.6 and Claude Opus
4.6–4.8, where thinking otherwise defaults to off. Claude 5 models already enable thinking by
default. Exact budgets map to native manual thinking:

```ts
reasoning: "high"
reasoning: { budgetTokens: 8_192 }
```

Claude 4.7 and later return empty thinking text unless a request asks for a summary, so wherever
thinking runs on those models the adapter sends `display: "summarized"`, and on Claude 5 and later,
which think by default, `thinking: { type: "adaptive", display: "summarized" }`. Thinking is billed
the same either way; no configuration is needed to see a model's reasoning.

Exact budgets must be at least 1,024 tokens and below the model call's `maxOutputTokens`. Unsupported
named efforts (including `none`) emit a `[SixbAnthropic]` warning and omit the reasoning override,
allowing the request to continue with provider-default reasoning. The live catalog normalizes
Anthropic's effort and thinking-mode flags into `definition.capabilities.reasoning`.
Claude Fable 5, Mythos 5 (including their 5.1 variants), and Mythos Preview always keep thinking on;
`reasoning: "none"` uses the same warning and provider-default fallback for direct, offline, and
catalog-resolved bindings, including compaction summaries.

The model definition is built synchronously from provider defaults and configured definitions.
Pricing lives separately in `model.costEstimator.estimate({ usage })`. Its exact token calculation
produces an **estimate**, with the applied rates retained as evidence. Constructing a model and
ordinary inference never fetch the cached, paginated catalog. A structured-output call consults it
only when native support is otherwise unknown; a catalog failure rejects structured output before
inference. Server tools disable token-only estimates when their additional charges would make a
token-only total incomplete.

Anthropic publishes no machine-readable prices, so base prices come from
[models.dev](https://models.dev). `await model.resolve?.()` downloads them once per provider and
keeps them in memory for `catalogTtlMs` (one hour by default); an offline resolution uses the prices
already in memory. An unresolved binding has no prices. Sixb resolves models before running them.
The rest follows Anthropic's [published multipliers](https://platform.claude.com/docs/en/about-claude/pricing):
one-hour cache writes cost twice the input price, US-only inference (`inference_geo: "us"`, Claude 4.6
and later) costs 1.1x, and fast mode doubles every meter on Claude Opus 5.5, Opus 5 and Opus 4.8.
Context tiers such as Claude Haiku 5.5's prompts over 100,000 tokens are priced per call.

Models models.dev does not list, and unknown pricing options, are `unpriceable`, not guessed.
Unknown pricing does not block inference. If models.dev is unavailable, resolution keeps the last
prices, or none, warns, and retries after a minute. Set `rateCard` on a binding for negotiated or
otherwise known prices; it replaces models.dev for that binding:

```ts
const model = anthropic("claude-sonnet-5-5", {
  rateCard: { currency: "USD", input: "1.6", output: "8", cacheReadInput: "0.08" },
})
```

Cost estimates use these rates and the completed call's usage. Native provider request and response
IDs are retained with usage for troubleshooting.

Retryable `429` and `5xx` responses are retried only before a stream begins. `maxRetries`,
`maxRetryDelayMs`, and `catalogTtlMs` are configurable. Provider request IDs and retry hints are
retained on `ModelProviderError`, and 5-minute and 1-hour cache writes are metered separately.
