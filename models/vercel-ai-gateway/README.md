# @sixb/vercel-ai-gateway

Callable Vercel AI Gateway provider for Sixb's core model contract. It uses native `fetch`, exposes
model metadata and fixed rate cards through the gateway catalog, and preserves routing and actual
gateway-reported billing.

```ts
import { vercelGateway } from "@sixb/vercel-ai-gateway"

const model = vercelGateway("openai/gpt-5.5")
```

`vercelGateway` reads `AI_GATEWAY_API_KEY` lazily and falls back to `VERCEL_OIDC_TOKEN` in Vercel
environments. Create an isolated provider when you need custom credentials, headers, transport, or
inline definitions:

```ts
import { createVercelGateway } from "@sixb/vercel-ai-gateway"

const gateway = createVercelGateway({ apiKey: process.env.MY_GATEWAY_KEY })
const model = gateway("anthropic/claude-sonnet-4.5", {
  providerOptions: { gateway: { sort: "cost" } },
})
const definitions = await gateway.catalog.list()
```

The remote catalog is cached in memory and is discovery-only. Constructing or running a model never
fetches it. Model instances use conservative synchronous capabilities unless configured explicitly.
Gateway-reported cost is authoritative; route-dependent prices are never collapsed into a local
estimate, and a missing report remains explicitly unpriceable.

Gateway reasoning uses named provider-neutral efforts, including `none` when the model can disable
reasoning:

```ts
reasoning: "high"
```

The catalog's `reasoning_options` are normalized into the efforts exposed by
`definition.capabilities.reasoning`. For budget-native models, Gateway translates named efforts to
the routed provider's token budget. The Responses API does not expose a portable exact-budget field,
so `{ budgetTokens }` is rejected by this adapter; use a named effort or an explicit native
`providerOptions` override when routing is constrained to a compatible provider.

Retryable `429` and `5xx` responses are retried only before a stream begins. `maxRetries`,
`maxRetryDelayMs`, and `catalogTtlMs` are configurable. Provider request IDs and retry hints are
retained on `ModelProviderError`; the routed provider/model and gateway-reported total are retained
as distinct accounting facts.
