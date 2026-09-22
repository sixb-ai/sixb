# Usage and limits

Sixb records model usage across generation, conversations, AI workflow steps, and embeddings.
View consumption in Atlas and set monthly limits for your project or specific users and groups.

## View usage

Open **AI usage** in Atlas to see token usage and costs. Filter by date, provider, or model, and
open **Model calls** to inspect individual calls.

Usage and cost depend on what the provider reports and the available pricing. Missing values
remain unknown rather than being counted as zero.

## Set a monthly limit

In **AI usage**, choose **Add limit** under **Monthly usage limits**:

1. Choose the project, user, service account, or group the limit applies to.
2. Select **Cost** or **Tokens** and enter the monthly amount.
3. Choose **Add limit** to save it.

Limits reset at the start of each UTC calendar month. Editing a limit does not reset consumption.
Every applicable limit must allow a call before it starts. Once a limit is reached, further calls
are blocked.

Limits control whether calls can start. They are not hard caps on a provider's bill, because a
call's actual usage can exceed its estimate. Use
[`maxOutputTokens`](./configuration.md#model-and-response-controls) to bound the output of an individual call.

## Embeddings

[Vector indexing and semantic search](../objects/querying.md#search-by-meaning) use the same
usage accounting and limits. A completed model call can count toward usage even if its result
cannot be saved. Calling a provider's `embed()` method directly bypasses these controls.

Automatic projection indexing uses the project's budget. If the budget is exhausted, embedding
generation waits while projections continue updating objects.

Keep the [workers](../deployment/overview.md#start-services) running so accounting can recover
from temporary storage failures. The CLI includes the required worker for embeddings-only projects,
without requiring a sandbox.

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
