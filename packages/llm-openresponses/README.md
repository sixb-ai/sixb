# @sixb/llm-openresponses

Responses/OpenResponses transport for `@sixb/llm`, implemented with native `fetch` and a bounded
SSE decoder. It includes a Vercel AI Gateway convenience factory.

```ts
import { vercelGateway } from "@sixb/llm-openresponses"

const gateway = vercelGateway()
const model = gateway.model("openai/gpt-5.5")
```

`vercelGateway()` reads `AI_GATEWAY_API_KEY` lazily by default. Pass `apiKey`, `headers`, or a custom
`fetch` to configure credentials and transport explicitly. For any Responses-compatible endpoint:

```ts
import { createOpenResponsesProvider } from "@sixb/llm-openresponses"

const provider = createOpenResponsesProvider({
  id: "internal-models",
  baseUrl: "https://models.example/v1",
  apiKey: () => process.env.INTERNAL_MODELS_KEY,
})
```

The adapter maps canonical Sixb messages and tools onto `/responses`, decodes arbitrarily chunked
SSE with bounded buffers, normalizes usage and finish reasons, sanitizes HTTP failures, and retains
opaque response items as ordered replay state.

Provider-native tools can be supplied through a model's `providerTools` option. Their opaque output
items are preserved for the next request even when Sixb has no portable representation for them.
