# @sixb/azure-ai-foundry

Azure AI Foundry models for Sixb. A project URL and API key resolve Azure deployments into
model capabilities, limits, reasoning controls, and reference prices from [models.dev](https://models.dev).

## Install

```sh
bun add @sixb/azure-ai-foundry
```

## Connect

```ts
import { createAzureAIFoundry } from "@sixb/azure-ai-foundry"

const foundry = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com/api/projects/my-project",
  apiKey: () => process.env.AZURE_AI_FOUNDRY_API_KEY,
})

const model = foundry("production") // Your Azure deployment name.
```

The full project URL and API key are required. The provider uses the same key to fetch project
deployments and call inference. Keys may be strings or synchronous/asynchronous functions;
functions receive an abort signal and are evaluated for each Azure HTTP attempt.

Model resolution always follows this sequence:

1. Find the deployment in the Azure project and read its model name, version, and publisher.
2. Look up the underlying model in models.dev.
3. Build the Sixb model definition and cost estimator, intersecting capabilities with adapter support.
4. Call Azure using the deployment name.

Construction is network-free. `resolve()` returns a pinned model for worker admission and
execution. A direct `stream()` resolves and pins the handle before inference. Discovery failures
and missing deployments stop resolution; they never fall back to guessing the model identity.

## Stream a response

```ts
const { events } = await model.stream({
  callId: crypto.randomUUID(),
  messages: [
    { role: "user", content: [{ type: "text", text: "Explain digital twins in one sentence." }] },
  ],
  tools: [],
  maxOutputTokens: 256,
  signal: AbortSignal.timeout(30_000),
})

for await (const event of events) {
  if (event.type === "text-delta") process.stdout.write(event.delta)
  if (event.type === "error") throw event.error
}
```

## Inspect and refresh

```ts
const deployments = await foundry.catalog.deployments()
const definitions = await foundry.catalog.list()
const chats = await foundry.catalog.list({ protocol: "chat" })

const resolved = await model.resolve()
console.log(resolved.definition)       // Effective capabilities and limits.
console.log(resolved.protocol)         // responses | chat | messages
console.log(resolved.metadata.catalog) // Catalog source and underlying model ID.

await foundry.catalog.refresh()
const refreshed = await model.resolve()
const cached = await model.resolve({ offline: true })
// `resolved` keeps its original definition and prices.
```

| Behavior | Rule |
| --- | --- |
| Catalog listings | Supported project deployments |
| Azure matching | Unique case-insensitive model ID match |
| `FW-` fallback | Unique normalized match in the models.dev Fireworks catalog |
| Fireworks normalization | Removes namespace/`FW-`; normalizes casing and numeric `5p3` → `5.3` |
| Variants | Preserves variant/date suffixes; excludes moving Fireworks `*-latest` aliases; rejects ambiguity |
| Missing catalog metadata | Stays unknown; explicit capability and pricing overrides are available |
| Refresh | Updates future resolutions; existing resolved models stay pinned |
| Offline resolution | Requires a cached deployment; performs no network requests |
| Publisher display | Azure publisher names are normalized for model logos; Fireworks GLM, Kimi, and DeepSeek catalog families identify their authors. Unknown families retain the Fireworks publisher. |

Resolved definitions include `publisher: { id, name }` and `via: "Azure AI Foundry"` for model
pickers, including custom provider namespaces. These fields do not change routing or capabilities.
Use `definition.publisher` to override the displayed author for an unrecognized model family.

## Protocols and controls

```ts
foundry("production")           // Catalog protocol → deployment flags → Responses.
foundry.responses("production")
foundry.chat("production")
foundry.messages("claude-production")
```

Responses and Chat use the project inference URL. Native Messages uses the owning resource's
`/anthropic/v1/messages` URL, derived from the project URL. A Messages deployment from a project
connection is rejected because the owning resource cannot be inferred from that record; configure
the provider with that resource's own project URL and API key.

| Feature | Responses | Chat | Messages |
| --- | --- | --- | --- |
| Streaming, local tools, structured output | Supported | Supported | Supported |
| Images | URL / inline | URL / inline | URL / inline |
| PDFs | Inline | — | URL / inline |
| Named reasoning efforts | Supported | Supported | Adaptive thinking |
| Exact reasoning budgets | — | — | Manual thinking |

Features require both model capability and adapter support. Unsupported controls fail locally.
Responses use full-history replay with `store: false` and encrypted reasoning. Replay is scoped to
the endpoint, deployment, and protocol. Chat compatibility is selected with `profile`;
DeepSeek reasoning replay uses `reasoningReplay: "tool-continuation"`.

Messages `thinkingMode` selects manual or adaptive thinking. Manual budgets start at 1024 tokens
and must stay below the output ceiling. Inline media has a 20 MiB aggregate default limit,
configurable with `maxInputFileBytes`. Provider-native tools, audio/video, and worker native-PDF
projection are unsupported. Direct calls rely on Azure for input/context enforcement.

Responses defaults to `reasoningSummary: "auto"` when Azure identifies the publisher as OpenAI,
the base model is `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `o3`, or `o4-mini`, and the resolved
capabilities declare reasoning. The automatic default is omitted when reasoning is `"none"`.
Set `reasoningSummary: false` to opt out, or select `"auto"`, `"concise"`, or `"detailed"` explicitly.
Unknown models and other publishers require an explicit setting; Chat and Messages are unchanged.
Encrypted reasoning is retained for replay separately and is not displayable text.

## Override capabilities and prices

Overrides supplement discovered model facts; deployment discovery remains mandatory. A new
binding exposes only its definition's identity until resolution. Limits and capabilities,
including explicit overrides, become available on the resolved model (or after direct streaming).

```ts
const model = foundry.chat("production", {
  definition: {
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    capabilities: { localTools: true },
  },
  rateCard: {
    currency: "USD",
    unit: "million-tokens",
    input: "1.00", // Illustrative rates; replace with your prices.
    output: "4.00",
    cacheReadInput: "0.25",
  },
})
```

Use either `rateCard` or `costEstimator`. Explicit definitions and prices override catalog defaults.
Model identity always comes from Azure.

## Usage and cost

Catalog prices are reference estimates, not Azure invoice prices. Fireworks fallback uses
direct-Fireworks reference prices. Supply your own rates for effective Azure pricing.

| Accounting | Behavior |
| --- | --- |
| Supported prices | Flat input/output/cache rates and context-based `cost.tiers` |
| Tier selection | Total input, including cached tokens, must exceed the threshold; selected rates apply to the whole call |
| Legacy pricing | `context_over_200k` must agree with the exact tier |
| Reservations | Conservative highest rates; same pinned card as completed estimates |
| Cache and reasoning | Partitions of totals; never counted twice |
| Zero cache writes | Need no price; positive writes without rates remain unpriceable |
| Messages cache TTLs | Catalog write rates cover five minutes only; one-hour writes need explicit rates, and reservations are unavailable when the requested TTL has no rate |
| Missing or ambiguous usage/prices | Explicitly unpriceable; missing counters are not zero |
| Unknown billing dimensions | Require a custom estimator |
| Response model mismatch | Not priced using the requested model's rates |
| Reasoning counts | Positive reports retained; zero trusted automatically only for OpenAI |
| `reasoningUsage` override | `"reported"` trusts reported zero; `"unknown"` omits reasoning partitions |

## Transport and caching

| Option / behavior | Default / contract |
| --- | --- |
| `catalog.ttlMs` / `catalog.timeoutMs` | One hour / 10 seconds |
| Catalog listing | One public snapshot per list/get/refresh, including with `catalog.ttlMs: 0` |
| `discovery.ttlMs` / `discovery.timeoutMs` | One hour / 5 seconds |
| Discovery bounds | 100 pages, 10,000 records, 4 MiB |
| Public catalog bound | 32 MiB; receives no Azure credentials or custom headers |
| Custom transport | `fetch`, `headers` shared by discovery and inference; `catalog.fetch` for the public catalog |
| Retries | Transient inference HTTP failures; no replay after stream acceptance or ambiguous network failure |
| Cancellation | Bounds waits; early stream return cancels and releases the reader |
| Diagnostics | Redacts acquired credentials/custom header values; preserves status, codes and retry timing |

## Test

From the repository root:

```sh
bun test ./models/azure-ai-foundry/tests/*.test.ts
```

Live tests require a project URL, API key, and deployment names configured in the test files.
They are billable; run one suite at a time.

```sh
SIXB_FOUNDRY_E2E=1 \
  bun --env-file=.env.test --env-file=.local/drafts/foundry-live.env \
  test ./models/azure-ai-foundry/tests/profiles.e2e.ts
```

| Live suite | Coverage | Request / output-token ceiling |
| --- | --- | --- |
| `profiles.e2e.ts` | Discovered deployment profiles | 8 / 4,096 |
| `contracts.e2e.ts` | Tools, images, durable replay, strict JSON and accounting | 16 / 16,384 |
| `provider.e2e.ts` | Protocol controls, tools, media, cancellation and errors | 40 / 16,000 |

Native Messages has fixture coverage; live verification requires a deployed Claude model.
