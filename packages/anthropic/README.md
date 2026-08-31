# @sixb/anthropic

Callable Anthropic provider for Sixb's core model contract. It uses the native Messages API, loads
current model capabilities and limits from Anthropic's model catalog, and rates token usage with
Anthropic's published family pricing.

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

Native server tools can be supplied beside Sixb's local tools:

```ts
const model = anthropic("claude-sonnet-5", {
  providerTools: [{ type: "web_search_20260209", name: "web_search" }],
})
```

The model catalog is cached in memory and supports pagination. Inference still works if catalog
enrichment is unavailable; known Claude families retain their published token pricing while
capabilities fall back conservatively.
