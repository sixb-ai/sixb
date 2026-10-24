# Models

Configure the AI models available to your project. Language models power conversations and
generation. Decision models classify inputs, score them against a rubric, and estimate probabilities.
Embedding models power semantic search. Audio models transcribe stored files and turn text into
speech, and image models generate images. [Browse providers](#providers) for installation and credentials.

## Language models

Register the models you want to use in `models.language`. You can mix providers in the same
catalog. Export model bindings when you want to reuse them in your code:

File: `lib/models.ts`

```ts
import { anthropic } from "@sixb/anthropic"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const openaiModel = vercelGateway("openai/gpt-5.5")
export const anthropicModel = anthropic("claude-sonnet-5")
```

Add them to your existing project configuration:

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { anthropicModel, openaiModel } from "./lib/models"

export const sixb = createSixb({
  // ...your existing providers
  models: { language: [openaiModel, anthropicModel] },
})
```

The first language model is the default. Chat users can choose from this catalog and adjust the
reasoning effort their selected model supports. An [AI workflow step](../workflows/overview.md#add-an-ai-task)
can select a model and reasoning effort through its `model` and `reasoning` options.

A model your code passes runs as given, with its own options, whether or not `models.language`
lists it; decision, audio and image models work the same way. The catalog is what chat users, the
Agent and the API choose from, and supplies the default when no model is passed:

```ts
defineAgentStep("second-opinion", {
  model: vercelGateway("openai/gpt-5.5"),
  instructions: "Review the draft and list its weakest claims.",
})
```

### Name and description

Give a model your own name and description with the `name` and `description` options of its
binding:

```ts
const gptModel = vercelGateway("openai/gpt-5.5", {
  name: "GPT",
  description: "A second opinion, useful to compare an analysis.",
})
```

They show in the chat's model picker and in the delegation guide of `spawn_agent`. Each replaces
the provider's own text; without them, the provider's name and description apply.

### Default reasoning

Give a model a default reasoning effort with the `reasoning` option of its binding:

```ts
const glmModel = vercelGateway("zai/glm-5.3-flash", { reasoning: "low" })

createSixb({ models: { language: [glmModel, openaiModel] } })
```

Sixb applies it whenever this model runs without an explicit choice: chat messages, AI workflow
steps, and `generate()` calls. Without one, the provider's own default applies. An explicit
`reasoning` always wins. Sixb checks the level of each model in `models.language` or on an AI
workflow step against the capabilities the provider declares at startup; if the provider later
reports that the model does not support it, the call falls back to the provider default. A
provider you write yourself sets the level as `defaultReasoning` on the `LanguageModel` it returns.

The default is an effort level. An AI workflow step can instead set its own `reasoning` to a level
or a token budget such as `{ budgetTokens: 4096 }`; Sixb checks it against the step's model the same
way at startup, budget range included.

Chat follows the project defaults until a user picks a model or an effort. Choosing a model starts
from that model's default reasoning, and **Reset** forgets the choice, so later changes
to your defaults reach the user again. The chosen reasoning is fixed when a message is sent, so a
retry runs with the same setting.

Chat answers and AI workflow steps can use the model's full output limit, reasoning included, as
long as the conversation leaves room for it in the context window. However long the conversation
gets, they keep at least 16,384 tokens (or a quarter of the window): older turns are summarized
before the conversation takes that room. A conversation with an attached file keeps to that minimum,
since Sixb cannot tell how much of the window a file takes. To spend less per answer, cap it with
`maxOutputTokens` on the binding, such as `vercelGateway("zai/glm-5.3-flash", { maxOutputTokens: 32_000 })`.
A chat answer cut short by this limit says so and can be continued; an AI workflow step fails.

## Generate a response

Use `sixb.models.language.generate()` inside an action or workflow step when your code supplies
the context for a model call. This step returns a summary of its input document:

File: `workflows/steps/summarize.ts`

```ts
import { defineWorkflowStep } from "@sixb/core"

export const summarize = defineWorkflowStep("summarize")
  .input({ document: "string" })
  .output({ summary: "string" })
  .run(async ({ input, sixb }) => {
    const { output } = await sixb.models.language.generate({
      instructions: "Summarize in one sentence. Use only facts in the document.",
      prompt: input.document,
    })

    return { summary: output }
  })
```

Add it to a [workflow](../workflows/overview.md#define-a-workflow) with `.then(summarize)`.
You can also generate inside an action's [writeback or effects handler](../actions/overview.md#call-external-systems).
Direct generation does not require a sandbox. For a task that needs tools, use an
[AI workflow step](../workflows/overview.md#add-an-ai-task).

### Model and response controls

Pass a model binding to override the default; it does not need to be in `models.language`. Use
`reasoning` to choose a supported effort and `maxOutputTokens` to limit the response. Inside a step
or action handler:

```ts
import { anthropicModel } from "../../lib/models"

const { output } = await sixb.models.language.generate({
  model: anthropicModel,
  prompt: input.document,
  reasoning: "high",
  maxOutputTokens: 1_000,
})
```

Available reasoning controls depend on the model and provider. See the [provider READMEs](#providers)
for supported options.

The result also includes `usage`, `cost`, and `finishReason`. Text cut short by the output limit
has `finishReason: "length"`. Calls are recorded and respect your [usage limits](./usage-and-limits.md).

## Structured output

Add an `output` schema to get a typed result. Inside a step or action handler:

```ts
const { output } = await sixb.models.language.generate({
  instructions: "Summarize the document and identify whether it requests a follow-up.",
  prompt: input.document,
  output: {
    summary: "string",
    requiresFollowUp: "boolean",
  },
})

output.summary // string
output.requiresFollowUp // boolean
```

Sixb validates the response against the schema. Invalid or incomplete output throws an error.
The selected model must support structured output.

## Decision models

Register a provider in `models.decision`. For example, install the TypeSafe provider and set
its credentials:

```bash
bun add @sixb/typesafe
export TYPESAFE_API_KEY="..."
```

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { typesafe } from "@sixb/typesafe"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    decision: [typesafe("jev-1.13.0")],
  },
})
```

The first decision model is the default; pass `model` to `evaluate()` to run another one, listed or
not. Decision models need neither a language model nor a sandbox.

### Define questions

Use `question.choice()` to select an option, `question.score()` to score against ordered levels,
and `question.probability()` for a yes/no probability. Questions can be reused across calls:

File: `lib/triage-questions.ts`

```ts
import { question } from "@sixb/core"

export const triageQuestions = {
  category: question.choice({
    instructions: "Identify the main issue in description.",
    options: {
      maintenance: "Breakdowns, leaks, and repairs",
      billing: "Invoices, payments, and refunds",
      other: "Any other request",
    },
  }),
  severity: question.score({
    instructions: "Assess the operational impact described in description.",
    levels: [
      "No operational impact",
      "Degraded operation; workaround available",
      "Operation stopped; no workaround",
    ],
  }),
  blocked: question.probability(
    "Does description explicitly report equipment that cannot operate?"
  ),
}
```

### Evaluate an input

Call `sixb.models.decision.evaluate()` inside an action's
[writeback or effects handler](../actions/overview.md#call-external-systems) or a workflow step:

```ts
import { triageQuestions } from "../../lib/triage-questions"

const { output } = await sixb.models.decision.evaluate({
  input: { description: "The cooling unit has stopped." },
  questions: triageQuestions,
})

output.category.choice // "maintenance" | "billing" | "other"
output.category.probabilities.maintenance // number from 0 to 1
output.severity.score // number from 0 to 2, possibly fractional
output.blocked.probability // number from 0 to 1
```

Scores are the expected level index, starting at zero. Use multiple probability questions when
several labels can apply to the same input. Validate thresholds on your application's data.
Calls are recorded and respect your [usage limits](./usage-and-limits.md).

For a workflow step, `decisionOutput()` derives the output schema from your questions:

File: `workflows/steps/triage.ts`

```ts
import { decisionOutput, defineWorkflowStep } from "@sixb/core"
import { triageQuestions } from "../../lib/triage-questions"

export const triage = defineWorkflowStep("triage")
  .input({ description: "string" })
  .output(decisionOutput(triageQuestions))
  .run(async ({ input, sixb }) => {
    const { output } = await sixb.models.decision.evaluate({
      input,
      questions: triageQuestions,
    })
    return output
  })
```

Add it to a [workflow](../workflows/overview.md#define-a-workflow) with `.then(triage)`.

## Audio transcription

Register a transcriber in `models.audio.transcription`. The first is the default:

```ts
import { createSixb } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    audio: { transcription: [vercelGateway.transcription("microsoft/mai-transcribe-2")] },
  },
})
```

Use an ordinary workflow step or an action's writeback/effects handler:

```ts
import { defineWorkflowStep, ref } from "@sixb/core"

export const transcribe = defineWorkflowStep("transcribe")
  .input({ audio: ref.file() })
  .output({ text: "string" })
  .run(async ({ input, sixb }) => {
    const { output } = await sixb.models.audio.transcribe({ audio: input.audio })
    return output
  })
```

The file must already exist in the project's blob storage, with an `audio/*` media type.
Sixb verifies its size and digest before sending it. Supported encodings and provider limits
depend on the selected model; Sixb does not transcode files or extract audio from video.
Pass a `model` to override the default, listed in `models.audio.transcription` or not, or an
`AbortSignal` as `signal` to cancel.

The result contains `output.text`, `usage`, `cost`, and `callId`. Audio-only projects need
neither a language model nor a sandbox. Calls use the same [accounting and limits](./usage-and-limits.md#audio-transcription)
as other models. Authorize access to the owning object in the application before accepting
a user-supplied file reference; a `FileRef` is an identifier, not an access grant.

## Image generation

Register image models in `models.image`. The first is the default:

```ts
import { createSixb } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    image: [
      vercelGateway.image("bfl/flux-3-image", { description: "Fast drafts and thumbnails" }),
      vercelGateway.image("google/gemini-3.1-flash-lite-image", {
        description: "Edits a reference image",
      }),
    ],
  },
})
```

A `description` says when to pick a model; without one, the provider's own description applies.

Generate images in a workflow step or an action's writeback/effects handler:

```ts
const { files, cost } = await sixb.models.image.generate({
  prompt: "Isometric warehouse floor plan, muted palette",
  size: "1024x1024",
})
```

`files` are the generated images as `FileRef`s, already saved to the project's blob storage. Store one on an object
property or show it in a page like any other file.

| Option | Meaning |
| --- | --- |
| `n` | How many images to generate. Defaults to 1; some models return one per call. |
| `size`, `aspectRatio` | Such as `1024x1024` or `16:9`. Accepted values depend on the model. |
| `quality`, `style` | Model-specific settings, such as `low` or `vector_illustration`. |
| `seed` | Repeat a result, where the model supports it. |
| `images` | Reference images, as `FileRef`s with an `image/*` media type, to edit or vary. |
| `model`, `signal` | Override the default model, listed in `models.image` or not, or cancel the call. |

Settings a model ignores come back in `warnings`. Each call is priced by the size, quality and
style it requested and the number of images returned, and uses the same
[accounting and limits](./usage-and-limits.md#image-and-speech-generation) as other models.
Authorize access to a reference image in the application before accepting a user-supplied
`FileRef`.

## Speech generation

Register speech models in `models.audio.speech`, beside any transcribers. The first is the default:

```ts
export const sixb = createSixb({
  // ...your existing providers
  models: {
    audio: { speech: [vercelGateway.speech("openai/tts-1-hd", { voice: "alloy" })] },
  },
})
```

```ts
const { file, cost } = await sixb.models.audio.speak({
  text: "Your order shipped this morning.",
  mediaType: "audio/mpeg",
})
```

`file` is the generated audio as a `FileRef` in the project's blob storage. A request without a `voice` uses the voice
the binding sets, so you can switch models without changing calls. Pass `model` to run another
one, listed or not. You can also pass `instructions` for style, `speed`, and `language`. Voices and formats depend on the model; Sixb
never converts formats, so a model that cannot produce the requested `mediaType` fails the call.

## Call models over the API

The same calls are available over HTTP, to a user or service account granted
`can.run(project.models)`:

```ts
defineRole("model.users", { grantedTo: [designers], grants: [can.run(project.models)] })
```

```text
POST /api/models/language/generations   { prompt, instructions?, maxOutputTokens?, reasoning? }
POST /api/models/image/generations      { prompt, n?, size?, aspectRatio?, quality?, style?, seed?, images? }
POST /api/models/audio/speech           { text, voice?, mediaType?, instructions?, speed?, language? }
POST /api/models/audio/transcriptions   { audio }
```

Each body takes an optional `model: { provider, modelId }`; without one, the kind's default
answers. Reference images and audio are `FileRef`s from [`POST /api/files`](../server/overview.md#files).
The response carries the `callId`, the `model` that answered, `usage` and `cost`, plus `text` or
`files`:

```json
{
  "callId": "call_…",
  "model": { "provider": "vercel-ai-gateway", "modelId": "bfl/flux-3-image-klein" },
  "files": [{ "blobId": "blob_…", "mediaType": "image/jpeg", "sizeBytes": 82749 }],
  "warnings": [],
  "usage": { "outputImages": 1 },
  "cost": { "status": "reported", "money": { "currency": "USD", "amountNanos": "8000000" } }
}
```

From the CLI, the same calls write their files where you say:

```bash
sixb models image "Isometric warehouse floor plan" --size 1024x1024 --output out/plan.png
sixb models image "Same plan, night lighting" --image out/plan.png --output out/night.png
sixb models speech "Your order shipped." --format mp3 --output out/shipped.mp3
sixb models transcribe call.wav
sixb models text "Summarize this week's incidents in one line"
```

```json
{ "callId": "call_…", "model": "bfl/flux-3-image-klein", "files": ["out/plan.jpg"], "cost": "$0.008" }
```

`--output` takes a file, numbered when a call returns several, or a directory ending in `/`. The
extension follows the file's type, so `files` lists the paths actually written. `--image` uploads
a reference image; repeat it for several. `sixb models calls files <call-id> --output <path>`
downloads a call's files again.

A call counts toward [AI usage and limits](./usage-and-limits.md) like any other: a limit that
is reached answers `429`. An option the model does not accept answers `400` before any inference,
and a provider failure answers `502`. Calls are synchronous; download a generated file through
its call, below.

## Read a call's files later

Every image and speech result carries a `callId`. The files a call produced stay readable through
it, by whoever can see the run that made the call:

```ts
const call = await sixb.models.calls.files(callId) // { callId, files, recordedAt } or null
```

```text
GET /api/ai/model-calls/:callId/files                        the call's files
GET /api/ai/model-calls/:callId/files/content?path=/files/0  one file's bytes
```

| Where the call ran | Who can read its files |
| --- | --- |
| A request to the API | The user or service account that made it |
| An agent thread, or a subagent of it | Whoever can read the thread |
| An action or workflow run, or a workflow's agent step | Whoever can view the run |

Anyone else gets `null`, or a 404 from the API. Seeing a call in
[AI usage](./usage-and-limits.md) shows what it cost, not what it produced.

## List the catalog

`GET /api/models` and `sixb models list` show every configured model by kind, with its default,
description, the options a request can use, and its price:

```bash
sixb models list --kind image
sixb models get bfl/flux-3-image
```

A price comes from the provider binding, as it bills: per token, image, character or second of
audio, by size or voice tier where it varies. A model with no known price says "price unknown"; it
can still be called, except while a [cost limit](./usage-and-limits.md#set-a-monthly-limit)
applies.

## Embedding models

Embedding models turn text into vectors for [semantic search](../objects/querying.md#search-by-meaning).
Export an embedding model binding from your project:

File: `lib/models.ts`

```ts
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const productEmbedding = vercelGateway.embedding("openai/text-embedding-3-small", {
  dimensions: 1536,
})
```

Register it in `models.embedding` alongside any language models:

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { anthropicModel, openaiModel, productEmbedding } from "./lib/models"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    language: [openaiModel, anthropicModel],
    embedding: [productEmbedding],
  },
})
```

Reference the same binding in an object's [vector search profile](../ontology/properties.md#configure-vector-search).
Sixb uses it to index the object's text and embed search queries. Both operations count toward
[AI usage and limits](./usage-and-limits.md#embeddings).

An embeddings-only project needs neither a language model nor a sandbox.

## Reranking models

Reranking models compare a search query with candidate documents. Register a binding to make it
available to [explicit query reranking](../objects/querying.md#rerank-search-results):

```ts
// lib/models.ts
export const relevanceModel = vercelGateway.reranking("voyage/rerank-2.5-lite")

// sixb.config.ts — alongside your other model bindings
models: {
  embedding: [productEmbedding],
  reranking: [relevanceModel],
}
```

Registration does not change search behavior. Each query must choose its reranking model.

## Providers

Each provider card opens its package README for installation, credentials, supported models,
and provider-specific options.

<div data-provider-library="models"></div>
