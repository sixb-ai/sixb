# @sixb/vercel-ai-gateway

Callable Vercel AI Gateway provider for Sixb's core model contract. It uses native `fetch`, loads
model metadata and pricing from the gateway catalog, and preserves routing and provider billing.

```ts
import { vercelGateway } from "@sixb/vercel-ai-gateway"

const model = vercelGateway("openai/gpt-5.5")
```

`vercelGateway` reads `AI_GATEWAY_API_KEY` lazily. Create an isolated provider when you need custom
credentials, headers, transport, or inline definitions:

```ts
import { createVercelGateway } from "@sixb/vercel-ai-gateway"

const gateway = createVercelGateway({ apiKey: process.env.MY_GATEWAY_KEY })
const model = gateway("anthropic/claude-sonnet-4.5", {
  providerOptions: { gateway: { sort: "cost" } },
})
const definitions = await gateway.catalog.list()
```

The remote catalog is cached in memory. Inference still works if catalog enrichment is unavailable;
those calls use conservative capabilities and provider-reported billing when present.
