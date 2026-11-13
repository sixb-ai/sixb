# @sixb/azure-ai-foundry

Azure AI Foundry models for Sixb. A project URL and API key resolve Azure deployments into
model capabilities, limits, reasoning controls, and reference prices from [models.dev](https://models.dev).
Language, embedding, decision, transcription, reranking, speech and image models are supported.

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

Language model resolution follows this sequence:

1. Find the deployment in the Azure project and read its model name, version, and publisher.
2. Look up the underlying model in models.dev.
3. Build the Sixb model definition and cost estimator, intersecting capabilities with adapter support.
4. Call Azure using the deployment name.

Construction is network-free. `resolve()` returns a pinned model for worker admission and
execution. A direct `stream()` resolves and pins the handle before inference. Discovery failures
and missing deployments stop resolution; they never fall back to guessing the model identity.
If models.dev is unavailable after successful Azure discovery, resolution uses cached catalog
facts or an explicit `definition`. Without either, it fails. Malformed catalog data still fails;
missing capabilities and prices remain unknown. Catalog listings and refresh report outages.

## Embeddings

Configure the resource endpoint separately: Foundry project endpoints do not route embeddings.

```ts
const foundry = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com/api/projects/my-project",
  apiKey: () => process.env.AZURE_AI_FOUNDRY_API_KEY,
  embeddings: {
    endpoint: "https://my-resource.openai.azure.com/openai/v1",
    apiKey: () => process.env.AZURE_OPENAI_API_KEY,
  },
})

export const productEmbedding = foundry.embedding("product-embedding", {
  model: { name: "text-embedding-3-small", version: "1" },
  dimensions: 1536,
})
```

Register this binding under `models.embedding` and use it in an ObjectType's vector profile.
Set `model` to your deployment's actual model name and version. A mismatch blocks inference;
changing the declared model or version excludes previously stored vectors from search.
The deployment name must exist in the project and refer to the same deployment on the configured
resource. For connected deployments, supply the owning resource's endpoint and key.

| Deployed model | Dimensions |
| --- | --- |
| `text-embedding-3-small` | 1–1536 |
| `text-embedding-3-large` | 1–3072 |
| `text-embedding-ada-002` | Exactly 1536 |

Text batches accept up to 2048 nonempty strings; Azure enforces token limits. Other model families,
including Cohere, are rejected. Calls return vectors in input order and propagate cancellation.

Sixb object indexing and text search apply [usage accounting and limits](../../docs/models/usage-and-limits.md).
Direct `productEmbedding.embed({ texts: ["running shoes"] })` bypasses Sixb accounting.
Reference prices come from models.dev; use `rateCard` or `costEstimator` for deployment-specific
pricing. Missing pricing remains unknown and blocks cost-limited calls before inference.

See [embedding internals](./docs/embeddings.md) for resolution, transport, and failure handling.

## Decision models

Deploy `Microsoft-Decision-1` in the project and register the deployment under `models.decision`.
Azure rejects deployment names that contain "Microsoft", so pass your own name, such as
`decision-1`:

```ts
export const decision = foundry.decision("decision-1")

// In your createSixb() options:
const models = { decision: [decision] }
```

Use it with `sixb.models.decision.evaluate()`, see
[decision models](../../docs/models/configuration.md#decision-models). With language model tiers, it
also picks the tier of each chat message on Auto; Azure answers in about 150–450 ms, within
Sixb's 2-second limit.

| Behavior | Rule |
| --- | --- |
| Deployment | Must run a decision model (`Microsoft-Decision-*`); others are rejected, and `foundry.chat()` rejects decision deployments |
| Inference | `POST /providers/microsoft/v1/systemone` on the resource origin, with the project's API key |
| Questions | Choice with 2–255 options, score with 2–10 levels, probability; Azure rejects a one-option choice |
| Context | 32,768 tokens for the input and the longest question; Azure's rejection is surfaced as is |
| `timeoutMs` | 30 seconds per evaluation, response included |
| Retries | None: errors carry `retryable` and `retryAfterMs`; quota is metered in requests per minute |
| Response model | Must be the deployment's model; answers from another are rejected, their usage kept |
| Price | `Microsoft-Decision-1` version 1: USD 0.042 per million input tokens, output free |

The price is Azure's retail meter "Microsoft Decision 1 1M Tokens", the same in every region
(verified 2026-11-13 against the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices?$filter=productName%20eq%20%27Microsoft%20Decision%20Models%27)).
Other decision models have unknown cost, not zero: pass `rateCard` or `costEstimator` for them. Connected deployments from another resource are rejected;
configure that resource's project URL and API key.

## Transcription

Deploy a transcription model in the project and register the deployment under
`models.audio.transcription`:

```ts
export const transcriber = foundry.transcription("transcribe", { language: "en" })

// In your createSixb() options:
const models = { audio: { transcription: [transcriber] } }
```

Use it with `sixb.models.audio.transcribe()`, see
[audio transcription](../../docs/models/configuration.md#audio-transcription).

| Deployed model | Billed by | Price (GlobalStandard) |
| --- | --- | --- |
| `gpt-4o-transcribe` | Audio input and text output tokens | USD 6 and 10 per million |
| `gpt-4o-mini-transcribe` | Audio input and text output tokens | USD 3 and 5 per million |
| `gpt-4o-transcribe-diarize` | Tokens | Unknown: Azure publishes no retail meter |
| `gpt-transcribe` | Audio duration, in whole seconds | USD 0.27 per hour |
| `whisper` | Audio duration | USD 0.36 per hour (Standard: 0.396) |

| Behavior | Rule |
| --- | --- |
| Deployment | Must run one of the models above; others are rejected, and `foundry.chat()` rejects transcription deployments |
| Inference | `POST /openai/deployments/<deployment>/audio/transcriptions?api-version=2024-10-21` on the resource origin, with the project's API key; the v1 API does not route audio deployments |
| Audio | Up to 25 MiB of FLAC, MP3, MP4/M4A, Ogg, WAV or WebM, sent as is; Sixb rejects other media types before the upload |
| `language` | ISO-639-1 code of the spoken language; omitted, the model detects it |
| Speakers | `gpt-4o-transcribe-diarize` returns the text only: Sixb's transcription result has no speaker segments yet ([#1142](https://github.com/sixb-ai/sixb/issues/1142)) |
| `timeoutMs` | 120 seconds per transcription, upload and response included |
| Retries | None: errors carry `retryable` and `retryAfterMs` |
| Price | Azure Retail Prices for the deployment's model version and SKU: GlobalStandard, DataZoneStandard and Standard (verified 2026-11-13) |

A deployment without a published price, such as `gpt-4o-transcribe-diarize` or a provisioned
SKU, has unknown cost, not zero: pass `rateCard` or `costEstimator`. A reservation is never
estimated, because neither tokens nor duration are known before Azure decodes the file, so a
[cost limit](../../docs/models/usage-and-limits.md#set-a-monthly-limit) blocks these calls.
Connected deployments from another resource are rejected.

## Reranking

Deploy a Cohere rerank model in the project and register the deployment under `models.reranking`:

```ts
export const reranker = foundry.reranking("rerank")

// In your createSixb() options:
const models = { embedding: [productEmbedding], reranking: [reranker] }
```

A query then names it with `.rerank({ model: reranker })`, see
[rerank search results](../../docs/objects/querying.md#rerank-search-results).

| Deployed model | Billed by | Price (GlobalStandard) |
| --- | --- | --- |
| `Cohere-rerank-v5-fast` | Input tokens | USD 0.02 per million |
| `Cohere-rerank-v5-pro` | Input tokens | USD 0.05 per million |
| `Cohere-rerank-v4.0-fast` | Searches | Unknown: USD 2 per 1,000 searches, a unit Sixb cannot price yet ([#1145](https://github.com/sixb-ai/sixb/issues/1145)) |
| `Cohere-rerank-v4.0-pro` | Searches | Unknown: USD 2.50 per 1,000 searches |

| Behavior | Rule |
| --- | --- |
| Deployment | Must run a `Cohere-rerank-*` model; others are rejected. Discovery reports `chat_completion` for Rerank v4.0, but `foundry.chat()` rejects it and catalog listings leave it out |
| Inference | `POST /providers/cohere/v2/rerank` on the resource origin, with the project's API key; every document is scored |
| `timeoutMs` | 30 seconds per call, response included; Sixb's query runtime also stops at 30 seconds |
| Retries | None: errors carry `retryable` and `retryAfterMs` |
| Price | Azure Retail Prices for Rerank v5 version 1 on GlobalStandard and DataZoneStandard (verified 2026-11-13); other v5 deployments take a `rateCard`, and Rerank v4.0 only a `costEstimator` that reads `usage.raw.search_units` |

Capacity sets the rate limit: Azure's rate-limit headers report one request and 1,000 tokens per
minute for each unit of a deployment's capacity. Connected deployments from another resource are
rejected.

## Speech

Deploy `gpt-4o-mini-tts` in the project and register the deployment under `models.audio.speech`:

```ts
export const voice = foundry.speech("tts", { voice: "coral" })

// In your createSixb() options:
const models = { audio: { speech: [voice] } }
```

Use it with `sixb.models.audio.speak()`, see
[speech generation](../../docs/models/configuration.md#speech-generation).

| Behavior | Rule |
| --- | --- |
| Deployment | Must run `gpt-4o-mini-tts`; others are rejected, `tts` and `tts-hd` because they stream no usage. `foundry.chat()` rejects speech deployments |
| Inference | `POST /openai/v1/audio/speech` on the resource origin, with the project's API key and `stream_format: "sse"`: only the event stream reports token usage |
| Formats | `audio/mpeg` (default), `audio/ogg` (Opus), `audio/aac` (ADTS), `audio/flac` and `audio/wav`; a reply in another format fails. A streamed WAV's header sizes are written once the file is complete |
| Stream | Complete only at its `speech.audio.done` event, which carries the usage: a stream cut off before it, or ending in an `error` event, fails with the usage it reported. Up to 128 MiB of audio |
| `voice` | Used when a request names none; default `alloy`. Azure rejects voices it does not have, listing those it does |
| Text | Up to 4,096 characters; `instructions` and `speed` are passed on (speed changes the length, not the tokens billed). `language` is not: the model reads the text in its own language, and the result warns |
| `timeoutMs` | 120 seconds per call, response included |
| Retries | None: errors carry `retryable` and `retryAfterMs` |
| Price | USD 0.60 per million text input tokens and USD 12 per million audio output tokens on GlobalStandard; DataZoneStandard and Standard are 10% more (Azure Retail Prices, versions 2025-03-20 and 2025-12-15, verified 2026-11-13) |

Other versions and SKUs have unknown cost, not zero: pass `rateCard` or `costEstimator`. The
audio's length, so its token count, is unknown before the call, so no reservation is estimated
and a [cost limit](../../docs/models/usage-and-limits.md#image-and-speech-generation) blocks these
calls. Connected deployments from another resource are rejected.

## Images

Deploy a GPT Image or FLUX model in the project and register the deployment under `models.image`:

```ts
export const images = foundry.image("image", { description: "Product shots and edits" })

// In your createSixb() options:
const models = { image: [images] }
```

Use it with `sixb.models.image.generate()`, see
[image generation](../../docs/models/configuration.md#image-generation).

| Deployed model | Per call | Reference images | Price (GlobalStandard) |
| --- | --- | --- | --- |
| `gpt-image-1` | Up to 10 | Up to 16 | USD 5 per million text input tokens, 40 per million image output tokens |
| `gpt-image-1-mini` | Up to 10 | Up to 16 | USD 2 and 8 per million |
| `gpt-image-1.5` | Up to 10 | Up to 16 | USD 5 per million text input, 10 per million text output, 32 per million image output tokens |
| `gpt-image-2` | Up to 10 | Up to 16 | USD 5 and 30 per million; text output, if any, is unpriced |
| `FLUX.1-Kontext-pro` | 1 | 1 | USD 0.04 per image |
| `FLUX-1.1-pro` | 1 | None | USD 0.04 per image |

| Behavior | Rule |
| --- | --- |
| Deployment | Must run one of the models above; others are rejected, and `foundry.chat()` rejects image deployments. FLUX.2 [pro] and [flex] are refused: they answer only Black Forest Labs' own route, with their own request and a per-megapixel price |
| Inference | `POST /openai/deployments/<deployment>/images/generations` or, with reference images, `/images/edits`, with `api-version=2025-04-01-preview` on the resource origin and the project's API key. The v1 API does not route FLUX.1 Kontext edits |
| Options | `size` and `quality` (GPT Image; sizes listed for gpt-image-1, -1-mini and -1.5) are passed on. `seed`, `style` and `aspectRatio` have no API field and come back as warnings, like `quality` for FLUX |
| Reference images | PNG, JPEG or WebP. Until a binding resolves it accepts up to 16; resolution narrows that to the deployment's limit |
| `timeoutMs` | 180 seconds per call, response included |
| Retries | None: errors carry `retryable` and `retryAfterMs` |
| Price | Azure Retail Prices for the deployment's model version on GlobalStandard and DataZoneStandard, and Standard for FLUX (verified 2026-11-13). Without a text output price, every output token bills at the image rate: gpt-image-1 reports no split |

A GPT Image edit has unknown cost: Azure bills its image input tokens at a rate Sixb's rate cards
cannot hold yet ([#1149](https://github.com/sixb-ai/sixb/issues/1149)). Other versions and SKUs
are unknown too, not zero: pass `rateCard` or `costEstimator`. FLUX's per-image price is reserved
before the call; GPT Image's tokens are not known before it, so a
[cost limit](../../docs/models/usage-and-limits.md#image-and-speech-generation) blocks those calls.
gpt-image-1, gpt-image-2 and FLUX1.1 [pro] are covered by fixtures only. Connected deployments from
another resource are rejected.

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
| Catalog listings | Supported language deployments; embedding, decision, transcription, reranking, speech and image deployments are left out |
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
foundry("production")           // Catalog protocol → Responses/Chat/Messages flags → Responses.
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

Every protocol accepts `reasoning`, the level Sixb applies when the model runs without an explicit
choice, such as `foundry.chat("production", { reasoning: "low" })`, and `name` and `description`,
which replace the catalog's own in the chat's model picker and in the delegation guide of
`spawn_agent`. A binding's `maxOutputTokens` caps every call, agents included.

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
| Retries | Transient language-model HTTP failures; no replay after stream acceptance or ambiguous network failure; none for embeddings, decisions, transcriptions, reranking, speech and images |
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
| `decision.e2e.ts` | Decision questions, accounting, errors and chat tier routing | 16 decisions / — |
| `transcription.e2e.ts` | Each transcription deployment, accounting and errors | 8 transcriptions / — |
| `reranking.e2e.ts` | Rerank v5 and v4 ranking, usage, pricing and errors, as direct calls | 8 rerank calls / — |
| `speech.e2e.ts` | Every format, MP3 and WAV through Sixb with accounting, a transcription round trip and errors | 9 speech calls / — |
| `image.e2e.ts` | gpt-image-1.5, gpt-image-1-mini and FLUX.1 Kontext through Sixb with accounting, an edit and errors | 6 image calls / — |

Native Messages has fixture coverage; live verification requires a deployed Claude model.
