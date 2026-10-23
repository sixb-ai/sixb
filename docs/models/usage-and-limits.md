# Usage and limits

Sixb records model usage across generation, conversations, AI workflow steps, embeddings, decisions, transcription, and reranking.
View consumption in your app and set monthly limits for your project or specific users and groups.

## View usage

Open **Observability › AI usage** from your app's user menu to see token usage and costs. Filter
by date range, provider, or model, and open an execution under **Model calls** to inspect its
individual calls. Seeing usage requires `can.observe(agent.usage)` in a
[role](../auth/authorization.md); adding and changing limits requires `can.manage(agent.usage)`.

Usage and cost depend on what the provider reports and the available pricing. Missing values
remain unknown rather than being counted as zero.

Keep the [workers](../deployment/overview.md#start-services) running so accounting can recover
from temporary storage failures. `sixb dev` and automatic `sixb worker-group` selection
include the required worker. If you select worker types explicitly, include `agent`, even
for projects that only use decision, embedding, or audio models. Accounting recovery does not require a sandbox.

## Set a monthly limit

In **AI usage**, choose **Add limit** under **Monthly limits**:

1. Choose the project, user, service account, or group the limit applies to.
2. Select **Cost** or **Tokens** and enter the monthly amount.
3. Choose **Add limit** to save it.

Limits reset at the start of each UTC calendar month. Editing a limit does not reset consumption.
Every applicable limit must allow a call before it starts. Once a limit is reached, further calls
are blocked.

Token limits count calls billed by tokens: generation, embeddings, and decisions. Transcription,
reranking, image generation, and speech are billed by audio duration, search, image, or character,
so only cost limits apply to them.

Limits control whether calls can start. They are not hard caps on a provider's bill, because a
call's actual usage can exceed its estimate. Use
[`maxOutputTokens`](./configuration.md#model-and-response-controls) to bound the output of an individual call.

## Embeddings

[Vector indexing and semantic search](../objects/querying.md#search-by-meaning) use the same
usage accounting and limits. A completed model call can count toward usage even if its result
cannot be saved. Calling a provider's `embed()` method directly bypasses these controls.

Automatic projection indexing uses the project's budget. If the budget is exhausted, embedding
generation waits while projections continue updating objects.

## Audio transcription

Calls to `sixb.models.audio.transcribe()` appear in **AI usage** with their cost and audio duration,
when available.

Vercel Gateway transcription is currently blocked when a cost limit applies, because Sixb
cannot estimate its cost before the call.

## Image and speech generation

Calls to `sixb.models.image.generate()` and `sixb.models.audio.speak()` appear in **AI usage** with
their cost.

A cost limit lets a call start only when Sixb can estimate its cost first:

| Model priced | Under a cost limit |
| --- | --- |
| Per image (most image models, Gemini image models) | Runs. Sixb reserves the price of every image requested. |
| Per character (most speech models) | Runs. Sixb reserves the price of the text. |
| By tokens (GPT Image, Gemini speech) | Blocked: the output's size is unknown before the call. |

A call with reference images is also blocked under a cost limit when its model is priced by
tokens. A model whose provider has no published price can only run without a cost limit.

## Reranking

Queries using `.rerank()` add one accounted model call for their candidates. Direct provider
`rerank()` calls bypass Sixb's usage and limit controls.

Gateway rerankers report a cost without token usage. Reranking counts toward cost limits only;
a model without catalog pricing cannot run while a cost limit applies.

## Permissions

Grant access to view usage and manage limits through a [role](../auth/authorization.md):

File: `security/roles/ai-usage-operators.ts`

```ts
import { agent, can, defineRole } from "@sixb/core"
import { financeAdmins } from "../groups/finance-admins"

export const aiUsageOperators = defineRole("ai-usage.operators", {
  grantedTo: [financeAdmins],
  grants: [can.observe(agent.usage), can.manage(agent.usage)],
})
```

`can.observe(agent.usage)` allows viewing usage and limits. `can.manage(agent.usage)` allows
creating and changing limits. Permission to use the agent does not include either grant.
