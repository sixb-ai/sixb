# @sixb/vercel-ai-gateway

Use [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) models in Sixb.

## Quick start

Responses serialization and stream/replay handling use Sixb's internal `@sixb/model-protocols`
package. Gateway owns authentication, catalog metadata, request/caching policy, routing, and pricing.

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

Reasoning content is normalized into Sixb's `reasoning-start`, `reasoning-delta`, and
`reasoning-end` events. This covers Gateway's `response.reasoning.*`, native Responses
`response.reasoning_text.*`, and `response.reasoning_summary_text/part.*` events, plus completed
reasoning item snapshots. Repeated completion snapshots do not duplicate streamed text; native
reasoning items, including encrypted content, are retained separately for replay. Token accounting
uses the reported `usage.output_tokens_details.reasoning_tokens` as `reasoningOutputTokens`,
independently of how much reasoning text the provider exposes. These tokens are included in
`outputTokens`, not added to it again.

## Model catalog and usage

```ts
const definitions = await gateway.catalog.list()
await gateway.catalog.refresh()
```

This discovery catalog lists language models. Configure its cache TTL with `catalogTtlMs`.
Workers resolve model metadata once per prepared binding. Supply `models` to `createVercelGateway`
to override catalog definitions.

Sixb records Gateway-reported costs, usage, routing, and request IDs. Local cost estimates are
retained separately when available; calls without reliable pricing are marked unpriceable.

## Embedding models

```ts
const contentEmbedding = vercelGateway.embedding("openai/text-embedding-3-small", {
  dimensions: 1536,
})

// Register in models.embedding and reference the same model in search.vectors.
const { vectors } = await contentEmbedding.embed({ texts: ["A search phrase"] })
```

Embedding calls reuse the gateway's base URL, credentials, headers and fetch implementation.
They use the OpenAI-compatible `/embeddings` endpoint, request float output and validate dimensions,
finite nonzero values and one unique response index per input. Results follow input order.
An empty batch returns no vectors without a request; empty texts are rejected. Pass `signal` to
cancel a call. Embedding calls do not retry implicitly; the language-model retry options do not
apply. Models must support the requested dimensions. Direct provider calls bypass Sixb accounting;
object indexing and text search use the shared usage, cost and limit controls.

Automatic projection batching is enabled for known OpenAI embedding models only. Their adapter
advertises conservative bounds of 2048 texts, 8191 UTF-8 bytes per text and 300,000 bytes total;
the indexer also applies smaller local page bounds. Other routes remain individual until their
limits are known. Inputs are never truncated.

## Decision models

```ts
const jev = vercelGateway.decision("typesafe-ai/jev")
// Register in your createSixb() options:
const models = { decision: [jev] }

// Inside an action or workflow step:
const result = await sixb.models.decision.evaluate({
  input: { message: "Please refund the duplicate charge." },
  questions: {
    refund: { type: "probability", instructions: "Is a refund requested?" },
  },
})
console.log(result.output.refund.probability)
```

Decision models use `POST /evaluate` with the same Gateway credentials, base URL, headers and
fetch configuration. All three Sixb question types (`choice`, `score`, `probability`) are supported;
state and instructions retain their structured form. Gateway calls probability questions `boolean`;
Sixb returns their probability without applying a threshold.

Jev independently rounds scores and probabilities to two decimal places. Sixb preserves those
values and allows the corresponding bounded rounding error when checking distributions and scores.

Pass `{ providerOptions, timeoutMs }` as the second argument to `decision()`. The default inference
timeout is 30 seconds. Cancellation reaches the transport. There are no automatic inference retries;
the language-model retry settings do not apply. Context limits are enforced by Gateway without
client-side truncation. `typesafe-ai/jev` is a Gateway alias, not a pinned TypeSafe version.

The runtime resolves cached catalog pricing before admission and retains one pricing snapshot per
call. Missing pricing or routing options that may change the tariff leave estimates unavailable;
enforced cost limits then fail closed. Gateway-reported charges take precedence over estimates.
Output token usage is retained even when the output tariff is zero. Invalid answers retain available
usage and billing metadata. Calling `jev.evaluate()` directly bypasses Sixb admission and accounting.

Run the optional live check with a Gateway credential and explicit opt-in. It makes one inference
request through Sixb with a $0.01 catalog-estimated budget:

```sh
SIXB_VERCEL_GATEWAY_DECISION_E2E=1 bun --env-file=.env.test test ./models/vercel-ai-gateway/tests/decision.e2e.ts
```
