# @sixb/azure-ai-foundry

Azure AI Foundry provider for Sixb. Uses native `fetch` and the shared
`@sixb/model-protocols` Responses, Messages, and Chat implementations. Supports resource/project
OpenAI v1 endpoints and resource-level native Claude, local tools, reasoning/replay,
native structured output, images, and PDFs. Calling the provider defaults to Responses;
use `.messages()` for native Claude or `.chat()` for explicit Chat Completions compatibility.

```ts
import { createAzureAIFoundry } from "@sixb/azure-ai-foundry"

const foundry = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com",
  providerId: "foundry-production",
  apiKey: () => process.env.AZURE_AI_FOUNDRY_API_KEY,
})

const model = foundry("support-prod", {
  definition: {
    maxInputTokens: 128_000, // Supply facts for your deployed offering.
    maxOutputTokens: 8_192,
    capabilities: {
      localTools: true,
      parallelToolCalls: true,
      nativeStructuredOutput: true,
      reasoning: { canDisable: true, efforts: ["low", "medium", "high"] },
      inputMediaTypes: ["image/png", "image/jpeg", "application/pdf"],
    },
  },
  metadata: {
    publisher: "OpenAI",
    modelName: "your-publisher-model",
    modelVersion: "your-deployed-version",
  },
  maxOutputTokens: 4_096,
})

// Equivalent explicit protocol selection:
const other = foundry.responses("another-deployment")
```

The wire `model` and Sixb `modelId` are the **deployment name**. Publisher/model/version metadata
is separate and never inferred from that name. Give different resources/projects distinct
`providerId` values when their deployment names may overlap in a Sixb catalog.

## Endpoints and authentication

Accepted endpoints are resource roots or project endpoints, optionally ending in `/openai/v1`:

```text
https://<resource>.openai.azure.com
https://<resource>.services.ai.azure.com/openai/v1
https://<resource>.services.ai.azure.com/api/projects/<project>
```

Project paths are preserved, and project inputs use explicit `type: "message"` items.
Legacy deployment paths, URL credentials, query strings, and fragments are rejected.
The v1 inference request does not add `api-version`.

Supply either `apiKey` or an async `tokenProvider`. Explicitly configuring both is an error.
Without either, the API key is read lazily from `AZURE_AI_FOUNDRY_API_KEY`. Responses keys use `api-key`;
Entra tokens use `Authorization: Bearer`. Custom headers cannot override authentication.
Credentials and custom header suppliers run on **every HTTP attempt**, including retries.

Azure Identity stays application-owned:

```ts
import { DefaultAzureCredential } from "@azure/identity"
import { createAzureAIFoundry } from "@sixb/azure-ai-foundry"

const credential = new DefaultAzureCredential()
const foundry = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com/api/projects/my-project",
  tokenProvider: async (signal) => {
    const token = await credential.getToken("https://ai.azure.com/.default", {
      abortSignal: signal,
    })
    return token.token
  },
})
```

Choose the token audience required by your endpoint/cloud. A token callback can supply a different
scope. Credential acquisition and retry waits are cancellable. HTTP 408, 429, and 5xx failures retry
at most twice by default; `maxRetries` and `maxRetryDelayMs` (default 60,000) bound this behavior.
Azure retry headers and genuine request IDs are retained. Network failures and accepted streams
are never automatically replayed. `fetch` can be injected for private transports and testing.

## Responses definitions, capabilities, and resolution

Pass inline `definition` metadata on a binding, or full `LanguageModelDefinition` entries in the
provider's `models` option. Without discovery, `catalog.get/list` exposes only those configured
provider entries and resolution returns the existing immutable local snapshot. Construction,
ordinary inference, and `resolve({ offline: true })` never make discovery calls. Per-binding
definitions override configured entries; explicit capability flags merge by field, including `false`.

Tools, media, native structured output, and named reasoning controls require explicitly declared
capabilities. Text generation works with unknown metadata. No model limits or prices are inferred
from deployment names. The output ceiling is the minimum of the definition, binding, and call limits.

`reasoning` maps to supported named `reasoning.effort` values; exact token budgets are rejected.
Unsupported explicit reasoning preferences fail before inference. `reasoningSummary` may be
`auto`, `concise`, or `detailed` for deployments supporting summaries.

Strict schemas must use the documented Azure subset: object root, closed objects, all properties
required, at most 100 properties and five nesting levels. Nullable unions and supported local
references/recursion are accepted. Unsupported constraints are rejected rather than removed.
Eligible tools use strict decoding only when native schema support is declared; other tool schemas
are sent unchanged with `strict: false`. Strict tools/structured output disable parallel tool calls.
Sixb still validates returned output against the original application contract.

## Optional project-deployment discovery

Enable discovery explicitly on a **project inference endpoint**:

```ts
const foundry = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com/api/projects/my-project",
  tokenProvider: async (signal) => {
    const token = await credential.getToken("https://ai.azure.com/.default", {
      abortSignal: signal,
    })
    return token.token
  },
  discovery: { ttlMs: 60 * 60 * 1_000 },
})

const definitions = await foundry.catalog.list()
const deployments = await foundry.catalog.deployments()
const binding = foundry.responses("support-prod")
const resolved = await binding.resolve()

console.log(resolved.metadata.publisher, resolved.metadata.modelName)
console.log(resolved.metadata.deployment?.sku, resolved.metadata.discoveredAt)

await foundry.catalog.refresh()
// `resolved` remains pinned. Resolve the original binding again to adopt refreshed metadata.
const refreshed = await binding.resolve()
```

Discovery calls `<project>/deployments?api-version=v1`, following `value`/`nextLink` pages. It uses
Entra authentication, inheriting the inference `tokenProvider` unless `discovery.tokenProvider`
is set. Inference API keys are never sent to discovery. Key-authenticated inference can use a
separate discovery token callback; key-only local operation needs no discovery configuration.
The selected identity must have project-list access, independently of inference permissions.
`discovery.headers` is separate from inference headers; `discovery.fetch` defaults to the provider's
injected fetch. Tokens and dynamic headers are reacquired per page.

All pages share one deadline (`timeoutMs`, default 5,000 ms), plus bounds on pages (`maxPages`,
default 100), records (`maxDeployments`, default 10,000), and aggregate response bytes
(`maxResponseBytes`, default 4 MiB). Continuations must stay on the same project's deployment-list
endpoint with API version v1. Redirects, repeated pages, and duplicate deployment names are rejected.
A connection name is retained as metadata; it cannot disambiguate the bare deployment name sent to
Responses, so duplicate names across connections fail instead of selecting one arbitrarily.

The catalog retains publisher/model/version, connection, SKU, and all string-valued capabilities.
Recognized Azure keys are interpreted conservatively:

- `responses: "true"` admits a discovered deployment to the language catalog. A known `"false"`
  rejects Responses resolution. Missing support remains unknown; Chat support alone does not imply
  Responses support. `deployments()` also exposes records absent from the language catalog.
- `maxContextToken` and `maxOutputToken` become `contextWindow` and `maxOutputTokens` when supplied
  as positive safe-integer strings. Context capacity is not reinterpreted as maximum input tokens.
- Recognized booleans require literal `"true"`/`"false"`; unknown keys remain raw strings.
  `jsonObjectResponse` is not evidence of native strict schemas. Tool, reasoning, and media support
  remain unknown until configured explicitly. No limits or capabilities are guessed from model names.

The default catalog view is Responses. Pass `{ protocol: "chat" }` to `catalog.list()`,
`catalog.get(name, options)`, or `catalog.refresh()` to select discovered deployments with
`chatCompletion: "true"` or the project API's `chat_completion: "true"`. Both views share the same
cached snapshot; contradictory aliases are rejected. `.chat().resolve()` checks Chat support
independently of `responses`, preserving Chat-only deployment metadata. A live project may report
only Chat support even for an OpenAI deployment that accepts Responses: use `deployments()` to
inspect all records and explicitly bind Responses rather than inferring that capability.

Configured definitions remain listed. Priority is discovered facts, then provider `models` entries,
then per-binding `definition`/`metadata` overrides. Discovered model identity feeds the existing
usage policy and explicit rate-card drift checks; discovery never invents a price.

Concurrent list/get/resolve/refresh operations share one load. The TTL defaults to one hour and
starts after a complete successful load. A refresh joins an existing load or starts a new one.
Only complete snapshots are published. Failures invalidate online freshness but retain the last
successful snapshot for explicit offline resolution, which may use stale cached metadata.
Transport, authentication, deadline, body-read, and HTTP failures are `ModelCatalogUnavailableError`;
invalid payloads, known malformed capability strings, pagination violations, and resource bounds
are errors rather than outages. A later online call retries after failure.

Online/offline resolution returns an immutable executable snapshot without mutating the original
binding. An already resolved model stays pinned even if `resolve()` is called again; start from the
original binding to adopt a new snapshot. Resource-root inference remains locally configured;
discovery is tied to the same project endpoint as inference to avoid attaching another resource's
deployment facts to a binding. Discovery does not modify Sixb's configured model allowlist.

## Responses history and files

Requests always use `store: false`, streaming, and full Sixb-owned history. Encrypted reasoning
is requested by default; set `encryptedReasoning: false` for deployments without that feature.
Signed/opaque items, tool-call IDs, and assistant phases are retained. Replay state is scoped to
the canonical endpoint, deployment, and protocol; incompatible or unscoped Foundry replay state
is rejected. Changing deployment configuration behind the same name remains an Azure operation.

Images support HTTP(S) URLs and canonical base64 data URLs. PDFs currently require inline base64:

```ts
const messages = [{
  role: "user" as const,
  content: [{
    type: "file" as const,
    mediaType: "application/pdf",
    filename: "report.pdf",
    data: new URL(`data:application/pdf;base64,${pdfBytes.toString("base64")}`),
  }],
}]
```

MIME types must match configured capabilities and inline data. An omitted PDF filename defaults
to `document.pdf`. `maxInputFileBytes` bounds aggregate decoded inline files (default 20 MiB);
it does not bound remote image downloads by the service. Remote PDF URLs, uploaded file IDs,
and worker upload-to-native-PDF projection are separate follow-up work.

Agent attachments still use durable file references and existing sandbox access. Native PDF
projection in the worker is deferred. Core's enforced token/cost admission currently rejects
non-text inputs and opaque replay when it cannot reserve their input cost; provider support does
not override those admission limits.

Additional native request fields can be supplied through `request` (for example `temperature`,
`top_p`, or `metadata`) when supported by the deployment. Adapter-owned fields are rejected,
including stored conversations, `previous_response_id`, background mode, and native tools.
No automatic cache configuration is added; `caching: "off"` leaves explicitly configured native
options intact and does not disable Azure's service-side caching.

## Responses usage and pricing

Raw usage is preserved. Missing cache counters remain unknown. Uncached input is derived only
from known, compatible total/cache-read counters. Reasoning/text partitions are trusted by
default only for explicitly identified OpenAI publishers; `reasoningUsage: "reported" | "unknown"`
overrides that policy. This avoids treating the documented non-OpenAI zero reasoning counter
as reliable. Completed stream events retain Azure filter metadata. Billable usage and cost
remain available even when local output validation fails.

Pricing is explicit and independent of operational metadata:

```ts
const model = foundry("support-prod", {
  rateCard: {
    currency: "USD",
    unit: "million-tokens",
    input: "2.00", // Illustrative only; use your actual offering's rates.
    cacheReadInput: "1.00",
    output: "10.00",
  },
})
```

Alternatively supply a `ModelCostEstimator` as `costEstimator`; configuring both is rejected.
No Azure retail-price lookup or publisher direct-API price fallback is performed. Missing prices
or required counters remain unpriceable. Explicit rate cards are snapshotted and support core's
exact decimal rates and conservative reservations.

Rate-card estimates decline unknown native pricing options/meters, nonzero cache-write counters
with unverified overlap semantics, non-token charges, and known response-model mismatches. An
explicit `cache_write_tokens: 0` is accepted; absent or null counters are not invented. When
metadata includes `modelName`, response identity must match it or `<modelName>-<modelVersion>`.
Some Azure Responses endpoints report the deployment name instead of publisher identity. Such
responses cannot satisfy that identity check and remain unpriceable with model-pinned rate cards.
For routing, PTU allocation, newer cache-write tariffs, or other pricing semantics, supply a custom
estimator. These are local estimates, never provider-reported charges or Azure invoice totals.

## Native Claude Messages

Use the resource that hosts the Claude deployment:

```ts
const foundry = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com",
  apiKey: () => process.env.AZURE_AI_FOUNDRY_API_KEY,
})

const claude = foundry.messages("support-claude", {
  metadata: {
    publisher: "Anthropic",
    modelName: "claude-sonnet-4-6",
    modelVersion: "1", // Foundry hosting version, not a publisher model-date suffix.
    hosting: "anthropic",
  },
  definition: {
    maxOutputTokens: 8_192,
    capabilities: {
      localTools: true,
      parallelToolCalls: true,
      nativeStructuredOutput: true,
      inputMediaTypes: ["image/png", "image/jpeg", "application/pdf"],
      reasoning: {
        canDisable: true,
        efforts: ["low", "medium", "high", "max"],
        budgetTokens: { min: 1_024 },
      },
    },
  },
  maxOutputTokens: 4_096,
  request: { cache_control: { type: "ephemeral", ttl: "5m" } },
})
```

Native requests use `/anthropic/v1/messages`, `anthropic-version: 2023-06-01`, and either
`x-api-key` or Entra Bearer authentication. Resource endpoints ending in `/anthropic` or
`/anthropic/v1` are also accepted. Authentication refreshes on every retry through the same
bounded transport as Responses. Custom `headers` can supply documented `anthropic-beta` values.

**Project endpoints are not accepted by `.messages()`.** A project can expose deployments from
different connected resources, and its URL does not identify the native Claude resource. Configure
a resource provider with explicit deployment metadata; project discovery remains available through
a separate project provider. Native construction, resolution, and inference require no catalog I/O.
Bindings preserve configured definitions, limits, metadata, prices, and request options as immutable
snapshots. `AzureAIFoundryModel<"messages">` is the protocol-specific model type, with options exposed
as `AzureAIFoundryMessagesOptions`.

### Claude capabilities and hosting

Capabilities must describe the deployed offering. The adapter does not import Anthropic's direct
model catalog or infer capabilities from a deployment name. Known constraints are checked against
explicit `metadata.modelName`, with Foundry hosting version `1` meaning Anthropic infrastructure
and `2` meaning Azure infrastructure. An explicit `hosting` value must agree with that version.
The checked profiles follow Microsoft's [Claude model reference](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/claude-models), reviewed September 16, 2026.

- Known Azure-hosted offerings in that reference are Opus 5, Opus 4.8, Sonnet 5, and Haiku 4.5.
  Selecting Azure hosting for a known Anthropic-only offering fails early.
- Mythos offerings require Entra authentication. Fable/Mythos cannot disable thinking.
- Opus 4.7/4.8/5, Sonnet 5, Fable 5/5.1, and Mythos 5/5.1 use adaptive thinking only.
  Opus 4.6, Sonnet 4.6, and Mythos Preview also support manual budgets.
- Named efforts require declared reasoning efforts and an adaptive profile. For an unlisted
  offering, configure `thinkingMode: "adaptive"` explicitly. Known profiles still constrain the
  request: Opus/Sonnet 4.6 reject `xhigh`, and Fable/Mythos 5 reject `max`.
- Manual budgets require declared budget support, at least 1,024 tokens, and a budget below the
  effective output ceiling. The adapter always uses the smallest definition/binding/call ceiling;
  at least one ceiling must be supplied because Messages requires `max_tokens`.
- Optional reasoning uses `thinking` plus `output_config.effort`; unsupported explicit controls
  fail rather than silently falling back. Explicit sampling controls cannot accompany explicitly
  enabled thinking. Provider-default reasoning leaves native thinking controls unset.

Local tools use native `tool_use`/`tool_result`, with parallel execution disabled unless declared.
Signed thinking, fragmented signatures, redacted thinking, and tool blocks survive durable history
serialization. Replay is scoped to the resource, deployment, and Messages protocol; Responses or
another deployment's opaque history cannot be replayed. System instructions must precede the
conversation; mid-conversation system-message beta semantics are not silently emulated by hoisting.

### Native schemas, media, and caching

Declared native structured output uses `output_config.format`. Eligible tools use `strict: true`;
other local tools retain their original schemas with strict mode unset. The conservative Claude
schema subset supports closed objects with optional properties, arrays, primitive types, scalar
enums/constants, `anyOf`, and standard formats. References, numeric/string bounds, patterns, and
other unsupported constraints reject native structured output. Schemas are never rewritten or
weakened, and Sixb validates the result against the application's original contract. Claude does
not inherit Responses' 100-property/five-level eligibility rules.

Declared image/PDF inputs support canonical inline base64 and HTTP(S) URLs. Inline files share
`maxInputFileBytes` (default 20 MiB); remote fetches are performed by Azure and are not bounded by
that local byte limit. PDF URLs are supported for Messages, while Responses still requires inline
PDFs. Native file IDs and file lifecycle operations are outside this adapter. Azure-hosted Claude
supports inline/URL images; its Files API differs from Anthropic-hosted offerings.

Configure automatic native caching explicitly with `request.cache_control`, using
`{ type: "ephemeral", ttl: "5m" | "1h" }` (TTL is optional). No cache policy is added implicitly;
Sixb's `caching: "off"` preserves explicit provider configuration. Cache eligibility and hits remain
service decisions. Server tools, MCP, containers, and context-editing request ownership are reserved;
Microsoft's web-fetch hosting guidance is contradictory, so those features need separate verified
support rather than inheriting the direct Anthropic provider's tool configuration.

### Native usage and prices

Messages `input_tokens` is **uncached** input. Total input adds explicitly reported cache reads and
cache writes. Five-minute and one-hour writes remain separate; cumulative stream updates replace
reported counters instead of adding them twice. Missing cache counters or TTL splits remain unknown.
Reasoning/text output partitions require a reported thinking count; output totals remain available
without it. Raw usage, stop reasons (including refusal, pause, and context exhaustion), response model
identity, and request IDs are preserved, including through local structured-output validation failure.

Supply a `rateCard` with actual offering-specific input/output/cache prices or a custom
`costEstimator`. Unknown meters, nonzero server-tool charges, unrecognized service tiers/geography,
model drift, and unrepresented request pricing options remain unpriceable. Known zero server-tool
meters and `service_tier: "standard"` do not introduce additional charges. Claude response identity
must match configured `modelName` when present; Foundry hosting version is never appended to it.
No direct Anthropic price fallback is used. CCU billing and legacy subscription differences require
your actual effective rates; local estimates do not claim to reproduce an Azure invoice.

## Chat Completions compatibility

```ts
const foundry = createAzureAIFoundry({
  endpoint: "https://my-resource.services.ai.azure.com/api/projects/my-project",
  tokenProvider: async (signal) => {
    const token = await credential.getToken("https://ai.azure.com/.default", {
      abortSignal: signal,
    })
    return token.token
  },
  discovery: {},
})

const chat = foundry.chat("support-chat", {
  metadata: { publisher: "DeepSeek", modelName: "DeepSeek-V4-Pro" },
  definition: {
    maxOutputTokens: 4_096,
    capabilities: { localTools: true }, // Declare only capabilities verified for your deployment.
  },
})
const resolved = await chat.resolve()
const catalog = await foundry.catalog.list({ protocol: "chat" })
```

Chat uses `<resource-or-project>/openai/v1/chat/completions`, preserving project routing. It shares
Responses authentication, credential refresh, bounded HTTP retries, cancellation, and Azure error
IDs. Calling the provider still selects Responses. Chat never falls back to another protocol, switches
endpoints, or retries an accepted stream. `AzureAIFoundryChatOptions` and
`AzureAIFoundryModel<"chat">` expose the typed API.

### Chat request profiles

`profile: "openai"` uses OpenAI-compatible strict-schema/tool parameters. Explicit DeepSeek publisher
or model metadata selects `"deepseek"` by default; arbitrary deployment names do not select profiles.
You can select the profile explicitly for a compatible offering. These are wire-compatibility policies,
not model catalogs: tools, schemas, media, and reasoning still require declared capabilities.

- `max_completion_tokens` carries the smallest definition/binding/call output ceiling. For a deployment
  requiring the older field, set `maxTokensParameter: "max_tokens"` explicitly.
- `systemRole` defaults to `"system"`; use `"developer"` when required by your deployment. Message
  order is preserved. The adapter sends full Sixb history and does not manage stored conversations.
- Named reasoning levels map to `reasoning_effort` only when the definition declares support for that
  level. Exact token budgets are rejected. DeepSeek R1/R1-0528 effort controls remain unverified in this
  adapter and require provider-default reasoning. No direct-DeepSeek `thinking` payload is inferred
  from Azure model names. For other DeepSeek offerings, declare only levels verified on your endpoint;
  a declared effort sends the wire parameter but does not prove the deployment honors it.
- GPT-5.6 model metadata enforces Azure's documented Chat restriction: any request with tools must
  explicitly use `reasoning: "none"`. This includes calls that would otherwise use provider-default
  reasoning. Use Responses for reasoning with tools on those offerings.
- OpenAI-compatible strict schemas use the same conservative Azure subset as Responses. Tools retain
  their original schemas; ineligible tools use non-strict mode. Parallel calls are disabled for strict
  tools or response schemas. The DeepSeek profile omits OpenAI strict/parallel-tool flags and rejects
  native strict structured output: advertised JSON mode is not evidence of schema-constrained decoding.
- Image inputs require declared MIME support and the existing inline byte bound. Chat PDF inputs,
  output audio, legacy `functions` calls, multiple choices, and provider-executed tools are unsupported.
  Use Responses or native Messages for their supported PDF paths.

The DeepSeek profile follows the Azure [`reasoning_content` extension and project Chat guidance](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-chat-reasoning).
The GPT-5.6 constraint follows the [Azure reasoning guide](https://learn.microsoft.com/azure/foundry/openai/how-to/reasoning#tool-calling-with-reasoning-models).
Foundry-specific behavior still needs live verification; another host's DeepSeek/GLM parameter support
does not establish Azure compatibility. In particular, conflicting Speciale tool claims are not turned
into inferred capabilities, and no unverified GLM thinking profile is added.

### Chat reasoning, streaming, and accounting

`delta.reasoning_content` becomes separate reasoning events. It is retained in scoped provider
metadata for durable history, but omitted from subsequent requests by default. If your deployed
DeepSeek offering requires thinking retention for tool use, opt in with
`reasoningReplay: "tool-continuation"`. Only same-provider reasoning on assistant tool-call messages
after the latest user message is replayed. Older-turn and foreign reasoning are omitted; other
endpoint/deployment/protocol state is rejected. Literal `<think>` tags stay ordinary text.

Chat streams are single-choice. Fragmented tool names/arguments are assembled by index; executable
calls are emitted only after successful tool-call completion and the `[DONE]` sentinel. Truncated or
filtered tool fragments are not executed. Missing completion markers, malformed identities, changing
response/model IDs, and terminal errors are surfaced instead of treating partial output as success.

By default, `stream_options.include_usage` requests the final usage chunk. Set `includeUsage: false`
only for offerings that reject that parameter. The decoder continues past the choice finish to retain
usage-only chunks and delayed Azure prompt/content filter annotations, including raw filter data and
offsets. Refusals and `content_filter` map to Sixb's content-filter finish. Annotations are retained on
the finish event under `providerData[providerId].annotations`; streamed text is not retroactively edited.

`prompt_tokens`/`completion_tokens` map to total input/output, while reported cached and reasoning
details remain separate. The last non-null usage snapshot is used without adding cumulative counters
twice. Missing cache counters and missing final usage remain unknown. Reasoning/text partitions are
trusted by default only for explicit OpenAI publisher metadata, or with `reasoningUsage: "reported"`.
Raw Chat counters are preserved. Explicit zero audio/prediction counters are accepted for ordinary
text calls. Nonzero or unknown cache-write, audio, prediction, image, and other additional meters
remain unpriceable rather than being forced into incompatible token partitions.
Explicit rates/custom estimators work as with Responses, including response-model drift checks.

## Verification scope

Deterministic fixtures cover endpoint/auth behavior, retries/cancellation, immutable definitions,
structured schemas, tools, encrypted durable replay, usage/pricing, images, and inline PDFs.
Discovery fixtures additionally cover pagination, cache refresh/coalescing, offline recovery,
metadata validation, connection ambiguity, and stalled credentials/transports/bodies. The project
wire shape follows the Azure AI Projects deployment reference and SDK; capability normalization
uses recognized Azure capability keys only when present. Native Claude fixtures cover both authentication modes,
model/hosting restrictions, tools and durable thinking replay, media, caching, structured output,
usage/pricing, stop reasons, and failures. These establish adapter behavior against documented wire
shapes, not live service verification. Chat fixtures additionally cover fragmented tools, Unicode,
final usage and delayed filters, cancellation, protocol-specific discovery, scoped tool continuation,
strict schemas, truncated/refused output, and terminal errors.

### Live Azure checks

Verified against usage-based deployments in West US 3 on September 16–17, 2026:

| Offering | Observed coverage |
| --- | --- |
| GPT-4.1 mini | Resource/project Responses and Chat, strict JSON, local tools and durable replay, inline images, Responses PDF, truncation/cancellation, real cache-read counters, explicit local rate calculation |
| GPT-5 mini | Responses encrypted reasoning replay; Responses/Chat named effort controls |
| DeepSeek-V3.2 | Chat text, function calls/results, final usage, nullable streaming fields |
| DeepSeek-V4-Pro | Chat reasoning, tool execution, and current-turn reasoning replay with `reasoningReplay: "tool-continuation"` |
| Project API | Entra authentication, deployment metadata, Chat catalog view, pinned/offline resolution, authenticated inference |
| Fireworks GLM-5.2-Fast | Resource/project Chat, local tool execution, strict JSON, final usage, project Responses with encrypted replay disabled |
| Claude | Not live-verified: Azure quota approval pending |

Fireworks models require the subscription's `Fireworks.EnableDeploy` feature to be registered.
Before registration they were absent from the ARM model catalogs. GLM-5.2-Fast was verified on
usage-based **DataZoneStandard**, in the same resource as the other deployments. See
[Microsoft's Fireworks setup guide](https://learn.microsoft.com/azure/foundry/how-to/fireworks/enable-fireworks-models).

Live observations are deployment-specific. GPT-4.1 mini occasionally returned two separate JSON
messages for a loosely worded structured-output prompt; Sixb correctly rejected the combined text
and retained usage. A strict schema is not a guarantee of one response message. DeepSeek-V3.2
accepted `reasoning_effort: "low"` without emitting reasoning in the probe, so parameter acceptance
alone is not proof of thinking support. Actual Azure invoice reconciliation remains unverified.

### Run the opt-in suite

Put credentials and deployment names in a gitignored environment file:

```dotenv
SIXB_FOUNDRY_E2E=1
AZURE_FOUNDRY_API_KEY=...
AZURE_FOUNDRY_OPENAI_ENDPOINT=https://<resource>.services.ai.azure.com/openai/v1
AZURE_FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
AZURE_FOUNDRY_FAST_DEPLOYMENT=<gpt-4.1-mini-deployment>
AZURE_FOUNDRY_OPENAI_DEPLOYMENT=<gpt-5-mini-deployment>
AZURE_FOUNDRY_DEEPSEEK_DEPLOYMENT=<DeepSeek-V3.2-deployment>

# Optional: use the current `az login` identity for project discovery and inference.
SIXB_FOUNDRY_E2E_ENTRA=1
# Optional additional offerings:
# AZURE_FOUNDRY_DEEPSEEK_REASONING_DEPLOYMENT=<DeepSeek-V4-Pro-deployment>
# AZURE_FOUNDRY_CLAUDE_DEPLOYMENT=<Claude-deployment>
# AZURE_FOUNDRY_GLM_DEPLOYMENT=<FW-GLM-5.2-Fast-deployment>
```

```sh
bun --env-file=.env.test test ./models/azure-ai-foundry/tests/provider.e2e.ts
```

The suite runs sequentially with timeouts, no automatic HTTP retries, at most 40 inference attempts,
and at most 16,000 requested output tokens per run. Missing deployment variables skip their tests;
without `SIXB_FOUNDRY_E2E=1`, all live tests skip. Reported totals exclude usage unavailable after
cancellation/errors and are not an invoice. Unit fixtures cover failure paths without paid requests.
