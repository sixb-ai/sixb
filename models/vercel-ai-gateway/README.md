# @sixb/vercel-ai-gateway

Use [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) models in Sixb.

## Quick start

```ts
import { vercelGateway } from "@sixb/vercel-ai-gateway"

const model = vercelGateway("openai/gpt-5.5")
```

Set `AI_GATEWAY_API_KEY`, or use `VERCEL_OIDC_TOKEN` in Vercel environments. Pass the returned
`LanguageModel` to your agent or register it in `models: { language: [model] }`.

## Configuration

```ts
import { createVercelGateway } from "@sixb/vercel-ai-gateway"

const gateway = createVercelGateway({ apiKey: () => process.env.MY_GATEWAY_KEY })
const model = gateway("anthropic/claude-sonnet-4.5", {
  maxOutputTokens: 4096,
  providerOptions: { gateway: { sort: "cost" } },
})
```

- **Caching:** automatic by default; set per-call `caching: "off"` to disable it.
- **Output limits:** the strictest per-call, configured, or model limit wins.
- **Retries:** `429` and `5xx` responses are retried before streaming starts. Configure
  `maxRetries` and `maxRetryDelayMs` on `createVercelGateway`.
- **Custom transport:** supply `baseUrl`, `headers`, or `fetch` on `createVercelGateway`.

## Structured output

Sixb sends strict JSON Schema requests and validates the returned output.

- Require every object property and set `additionalProperties: false`; use nullable fields where needed.
- Missing catalog metadata allows the request; it does not guarantee provider support.
- Workflow agents check known model and schema incompatibilities before their first model call.
- Failure phase and cause summaries are available in Atlas and the workflow run's `error.details`.

Unsupported configurations raise `UnsupportedModelFeatureError`; endpoint failures raise
`ModelProviderError`. There is no JSON-tool fallback.

## Reasoning

Use a named effort in your agent configuration:

```ts
reasoning: "high"
```

Unsupported efforts produce a warning and fall back to provider defaults. Omit `reasoning` or use
`"provider-default"` to leave it to the provider. Exact `{ budgetTokens }` budgets are not supported.

## Model catalog and usage

```ts
const definitions = await gateway.catalog.list()
await gateway.catalog.refresh()
```

The catalog is cached; configure its TTL with `catalogTtlMs`. Workers resolve model metadata once
per prepared binding. Supply `models` to `createVercelGateway` to override catalog definitions.

Sixb records Gateway-reported costs, usage, routing, and request IDs. Local cost estimates are
retained separately when available; calls without reliable pricing are marked unpriceable.
