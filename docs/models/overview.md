# AI

Use AI to generate results, search by meaning, or give users an agent that works with their
data and the actions you define.

## Configure a model

Choose a [model provider](./configuration.md), install its package, and set its credentials. Add
models to your existing project configuration. The first language model is the default.

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const sixb = createSixb({
  // ...your existing providers
  models: {
    language: [vercelGateway("openai/gpt-5.5")],
  },
})
```

For a prompt with context supplied by your code, use
[model generation](./generation.md) inside an action or workflow step. It returns text or
validated structured data.

### Embedding models

Embedding models turn text into vectors for [semantic search](../objects/querying.md#search-by-meaning).
Export a model binding from your project:

```ts
// lib/models.ts
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const productEmbedding = vercelGateway.embedding("openai/text-embedding-3-small", {
  dimensions: 1536,
})
```

Register it in `models.embedding` in your existing configuration:

```ts
// sixb.config.ts
import { createSixb } from "@sixb/core"
import { productEmbedding } from "./lib/models"

export const sixb = createSixb({
  // ...your existing providers
  models: { embedding: [productEmbedding] },
})
```

Language models and a sandbox are optional for an embeddings-only project. Reference the same
binding in an object's [vector search profile](../ontology/properties.md#configure-vector-search).
For other providers, see their [package READMEs](./configuration.md).

## Built-in agent

The agent can explore your domain, query data, and use the actions you define. It includes saved
conversations and a chat interface in Atlas and your app. Add [tools and skills](./tools-and-authorization.md)
when it needs capabilities or instructions specific to your project.

Alongside a model, configure a [sandbox provider](../sandboxes/overview.md#configure-a-sandbox).
The agent uses it to read files and run commands.

Grant users access to the agent and the data it should be able to read. For example, this role
lets your existing employees group use the agent with invoices:

File: `security/roles/assistant-user.ts`

```ts
import { agent, can, defineRole } from "@sixb/core"
import { Invoice } from "../../ontology/invoice"
import { employees } from "../groups/employees"

export const assistantUser = defineRole("assistant.user", {
  grantedTo: [employees],
  grants: [can.run(agent), can.view(Invoice)],
})
```

The agent uses the signed-in user's permissions. Grant access to actions and workflows through
[roles](../auth/authorization.md) as needed.

## Use in your app

[Sixb apps](../apps/overview.md) include the chat interface at `/agents`. You can also embed
`AgentPanel` in an existing page and give it context from that page:

File: `app/_components/invoice-assistant.tsx`

```tsx
import { AgentPanel, agentContext } from "@sixb/app/agents"
import { Invoice } from "../../ontology/invoice"

export function InvoiceAssistant({ invoiceId }: { invoiceId: string }) {
  return (
    <AgentPanel
      className="h-[32rem]"
      context={[agentContext.object(Invoice, invoiceId)]}
    />
  )
}
```

Context tells the agent what the user is looking at. It does not grant additional access.

For an agent that completes a task within an automated process, use an
[AI workflow step](../workflows/overview.md#add-an-ai-task).
