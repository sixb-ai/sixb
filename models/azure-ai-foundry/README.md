# @sixb/azure-ai-foundry

Azure AI Foundry models for Sixb. Discover deployments from Azure and model capabilities,
limits, reasoning controls, and reference prices from [models.dev](https://models.dev).

## Install

```sh
bun add @sixb/azure-ai-foundry @azure/identity
```

## Connect

### Microsoft Entra — automatic deployment discovery

```ts
import { DefaultAzureCredential } from "@azure/identity"
import { createAzureAIFoundry } from "@sixb/azure-ai-foundry"

const credential = new DefaultAzureCredential()
const foundry = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com/api/projects/my-project",
  tokenProvider: async (signal) => {
    const { token } = await credential.getToken("https://ai.azure.com/.default", {
      abortSignal: signal,
    })
    return token
  },
})

const model = foundry("production") // Your Azure deployment name.
```

### API key — supply the underlying model ID

API keys cannot discover deployment aliases. Azure Identity is optional for this setup.

```ts
import { createAzureAIFoundry } from "@sixb/azure-ai-foundry"

const foundry = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com",
  apiKey: () => process.env.AZURE_AI_FOUNDRY_API_KEY,
})

const model = foundry("production", {
  metadata: { modelName: "gpt-4.1-mini" }, // Underlying model, not deployment alias.
  maxOutputTokens: 4096,
})
```

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

Construction is network-free. The first `stream()` resolves and pins the model's configuration.

## Discover and refresh

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
| Catalog listings | Project deployments and configured definitions |
| Azure matching | Exact model ID, then a unique case-insensitive match |
| `FW-` fallback | Unique normalized match in the models.dev Fireworks catalog |
| Fireworks normalization | Removes namespace/`FW-`; normalizes casing and numeric `5p3` → `5.3` |
| Variants | Preserves variant/date suffixes; excludes `*-latest`; rejects ambiguity |
| Missing metadata | Stays unknown; explicit overrides are available |
| Refresh | Updates future resolutions; existing resolved models stay pinned |
| Offline resolution | Uses cached metadata without network requests |

## Choose a protocol

```ts
foundry("production")           // Catalog protocol → deployment flags → Responses.
foundry.responses("production")
foundry.chat("production")

// Native Messages requires a resource endpoint.
const resource = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com",
  apiKey: () => process.env.AZURE_AI_FOUNDRY_API_KEY,
})
resource.messages("claude-production", {
  metadata: { modelName: "your-models-dev-azure-id" },
})
```

Features require both model capability and adapter support. Unsupported controls fail locally.

| Feature | Responses | Chat | Messages |
| --- | --- | --- | --- |
| Streaming, local tools, structured output | Supported | Supported | Supported |
| Images | URL / inline | URL / inline | URL / inline |
| PDFs | Inline | — | URL / inline |
| Named reasoning efforts | Supported | Supported | Adaptive thinking |
| Exact reasoning budgets | — | — | Manual thinking |
| Project endpoint | Supported | Supported | — |

| Setting | Behavior |
| --- | --- |
| Responses replay | Full history, `store: false`, encrypted reasoning |
| Replay scope | Endpoint, deployment, and protocol must match |
| Chat compatibility | Explicit `profile`; reasoning replay uses `reasoningReplay: "tool-continuation"` |
| Messages thinking | `thinkingMode` selects manual/adaptive behavior; manual budgets start at 1024 tokens and stay below the output ceiling |
| Inline media | 20 MiB default aggregate limit; configure `maxInputFileBytes` |
| Unsupported features | Provider-native tools, audio/video, worker native-PDF projection |
| Context limits | Discovered metadata; direct calls rely on Azure for input/context enforcement |

## Override capabilities and prices

Supply missing model facts or your effective Azure rates. Capabilities remain bounded by adapter support.

```ts
const explicit = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com",
  apiKey: () => process.env.AZURE_AI_FOUNDRY_API_KEY,
  catalog: false,
  discovery: false,
})

const model = explicit.chat("production", {
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

## Usage and cost

> Catalog prices are reference estimates, not Azure invoice prices. Fireworks fallback uses
> direct-Fireworks reference prices. Supply your own rates for effective Azure pricing.

| Accounting | Behavior |
| --- | --- |
| Supported prices | Flat input/output/cache rates and context-based `cost.tiers` |
| Tier selection | Total input, including cached tokens, must exceed the threshold; selected rates apply to the whole call |
| Legacy pricing | `context_over_200k` must agree with the exact tier |
| Reservations | Conservative highest rates; same pinned card as completed estimates |
| Cache and reasoning | Partitions of totals; never counted twice |
| Zero cache writes | Need no price; positive writes without rates remain unpriceable |
| Missing or ambiguous usage/prices | Explicitly unpriceable; missing counters are not zero |
| Unknown billing dimensions | Require a custom estimator |
| Response model mismatch | Not priced using the requested model's rates |
| Reasoning counts | Positive reports retained; zero trusted automatically only for OpenAI |
| `reasoningUsage` override | `"reported"` trusts reported zero; `"unknown"` omits reasoning partitions |

## Transport and caching

| Option / behavior | Default / contract |
| --- | --- |
| `catalog.ttlMs` / `catalog.timeoutMs` | One hour / 10 seconds |
| `discovery.ttlMs` / `discovery.timeoutMs` | One hour / 5 seconds |
| Discovery bounds | 100 pages, 10,000 records, 4 MiB |
| Public catalog bound | 32 MiB; receives no Azure credentials or inference headers |
| Custom transport | `fetch`, `headers`; independent overrides in `catalog` and `discovery` |
| Credentials | Resolved on each HTTP attempt |
| Retries | Transient HTTP failures; no replay after stream acceptance or ambiguous network failure |
| Cancellation | Bounds waits; early stream return cancels and releases the reader |
| Diagnostics | Redacts acquired credentials/custom header values; preserves status, codes and retry timing |

## Test

From the repository root:

```sh
bun test models/azure-ai-foundry/tests/
```

Live tests require credentials and deployments configured in the test files. They are billable;
run one suite at a time.

```sh
SIXB_FOUNDRY_E2E=1 SIXB_FOUNDRY_E2E_ENTRA=1 \
  bun --env-file=.env.test --env-file=.local/drafts/foundry-live.env \
  test ./models/azure-ai-foundry/tests/profiles.e2e.ts
```

| Live suite | Coverage | Request / output-token ceiling |
| --- | --- | --- |
| `profiles.e2e.ts` | Discovered deployment profiles | 8 / 4,096 |
| `contracts.e2e.ts` | Tools, images, durable replay, strict JSON and accounting | 16 / 16,384 |

Native Claude live verification remains quota-blocked; fixture coverage includes all three protocols.
