# @sixb/anthropic

Callable Anthropic provider for Sixb's core model contract. It uses the native Messages API and a
small provider-owned rate card for Anthropic's published family prices. Current model metadata and
limits remain available through the explicit catalog API.

```ts
import { anthropic } from "@sixb/anthropic"

const model = anthropic("claude-sonnet-5")
```

`anthropic` reads `ANTHROPIC_API_KEY` lazily. Create an isolated provider when you need custom
credentials, headers, beta features, transport, or inline definitions:

```ts
import { createAnthropic } from "@sixb/anthropic"

const provider = createAnthropic({
  apiKey: process.env.MY_ANTHROPIC_KEY,
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

`maxOutputTokens` is optional. Anthropic requires `max_tokens` on every Messages request, so the
adapter resolves an omitted value to the selected Claude model's provider-owned output limit (128K,
64K, or the appropriate legacy limit). An explicit value lowers that ceiling. Unknown non-Claude
models require an explicit value; inference never fetches the catalog to discover one.

Native server tools can be supplied beside Sixb's local tools:

```ts
const model = anthropic("claude-sonnet-5", {
  providerTools: [{ type: "web_search_20260209", name: "web_search" }],
})
```

Agent and model-loop reasoning uses the shared provider-neutral preference. Anthropic named efforts
map directly to `output_config.effort`; exact budgets map to native manual thinking:

```ts
reasoning: "high"
reasoning: { budgetTokens: 8_192 }
```

Exact budgets must be at least 1,024 tokens and below the model call's `maxOutputTokens`. Unsupported
efforts fail locally and are never silently rounded to another level. The live catalog normalizes
Anthropic's effort and thinking-mode flags into `definition.capabilities.reasoning`.

The model definition is built synchronously from provider defaults, configured definitions, and the
local rate card. The cached, paginated catalog is discovery-only: constructing or running a model
never fetches it. Server tools omit the local rate card when their additional charges would make a
token-only total incomplete.

Retryable `429` and `5xx` responses are retried only before a stream begins. `maxRetries`,
`maxRetryDelayMs`, and `catalogTtlMs` are configurable. Provider request IDs and retry hints are
retained on `ModelProviderError`, and 5-minute and 1-hour cache writes are metered separately.
