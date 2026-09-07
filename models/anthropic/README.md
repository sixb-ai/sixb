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

```ts
import { anthropic } from "@sixb/anthropic"

const model = anthropic("claude-sonnet-5")
```

`anthropic` reads `ANTHROPIC_API_KEY` lazily. Create an isolated provider when you need custom
credentials, headers, beta features, transport, or inline definitions:

```ts
import { createAnthropic } from "@sixb/anthropic"

const provider = createAnthropic({
  apiKey: () => process.env.MY_ANTHROPIC_KEY,
  betas: ["example-beta"],
})

const model = provider("claude-opus-5", {
  maxOutputTokens: 16_384,
  request: {
    cache_control: { type: "ephemeral" },
  },
})

const definitions = await provider.catalog.list()
```

Share the configured provider or model through normal imports. Agents accept the returned
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
64K, or the appropriate legacy limit). An explicit value lowers that ceiling. Unknown non-Claude
models require an explicit value; inference never fetches the catalog to discover one.

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

Exact budgets must be at least 1,024 tokens and below the model call's `maxOutputTokens`. Unsupported
named efforts (including `none`) emit a `[SixbAnthropic]` warning and omit the reasoning override,
allowing the request to continue with provider-default reasoning. The live catalog normalizes
Anthropic's effort and thinking-mode flags into `definition.capabilities.reasoning`.
Claude Fable 5, Mythos 5 (including their 5.1 variants), and Mythos Preview always keep thinking on;
`reasoning: "none"` uses the same warning and provider-default fallback for direct, offline, and
catalog-resolved bindings, including compaction summaries.

The model definition is built synchronously from provider defaults and configured definitions.
Pricing lives separately in `model.costEstimator.estimate({ usage })`. Its exact token calculation
uses provider-owned rates and produces an **estimate**, with the applied rates retained as evidence.
Constructing a model and ordinary inference never fetch the cached, paginated
catalog. A structured-output call consults it only when native support is otherwise unknown; a
catalog failure rejects structured output before inference. Server tools disable token-only estimates when
their additional charges would make a token-only total incomplete.

Rates cover exact model IDs and supported request dimensions, with explicit cache prices:
new versions, unlisted dated snapshots, and unknown pricing options are `unpriceable`, not guessed.
Unknown pricing does not block inference. The table records its verification date and
[public pricing source](https://platform.claude.com/docs/en/about-claude/pricing);
these rates do not account for negotiated discounts or replace an invoice.

Cost estimates use local rates and the completed call's usage. Native provider request and response
IDs are retained with usage for troubleshooting.

Retryable `429` and `5xx` responses are retried only before a stream begins. `maxRetries`,
`maxRetryDelayMs`, and `catalogTtlMs` are configurable. Provider request IDs and retry hints are
retained on `ModelProviderError`, and 5-minute and 1-hour cache writes are metered separately.
