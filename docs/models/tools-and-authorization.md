# Tools and skills

Tools let the agent call your code. Skills give it instructions for completing a task. The agent
already knows how to explore your domain and use its actions; add tools and skills for capabilities
specific to your project.

## Define a tool

Use `defineAgentTool()` to describe a tool, declare its input, and implement its handler. This
example uses a project connector with a `search()` method:

File: `agent-tools/search-knowledge.ts`

```ts
import { defineAgentTool } from "@sixb/core"
import { knowledgeConnector } from "../connectors/knowledge"

export const searchKnowledge = defineAgentTool("search_knowledge")
  .description("Search project knowledge.")
  .input({ query: "string" })
  .run(async ({ input, signal, connector }) => {
    const knowledge = await connector(knowledgeConnector)
    return knowledge.search(input.query, { signal })
  })
```

The input schema validates arguments from the model. Return JSON-compatible data, and pass
`signal` to requests that support cancellation. Resolving a [connector](../connectors/overview.md)
in the handler keeps its credentials on the server.

## Register the tool

Add tools to your existing project configuration. Tools are registered explicitly, rather than
discovered from their folder:

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { searchKnowledge } from "./agent-tools/search-knowledge"

export const sixb = createSixb({
  // ...your existing providers, models, and sandboxes
  tools: [searchKnowledge],
})
```

Project tools are available to the conversational agent. To use a tool in an
[AI workflow step](../workflows/overview.md#add-an-ai-task), include it in that step's `tools`.
Only expose operations and data that the tool's intended users should be able to access.

## Add a skill

Create a folder under `skills/` with a `SKILL.md` file. Use its name and description to explain
when the agent should use it, then write the instructions:

File: `skills/invoice-review/SKILL.md`

```md
---
name: invoice-review
description: Review invoices for missing details and payment discrepancies.
---

1. Compare the invoice with the linked purchase order.
2. Flag missing references or mismatched amounts.
3. Report the findings without changing the invoice.
```

Sixb discovers project skills automatically. The agent sees their names and descriptions, then
reads the full instructions when relevant. Supporting files can live alongside `SKILL.md` and be
referenced by relative path.

Skills guide behavior; they do not grant access. Domain operations still follow the agent's
[permissions](./overview.md#built-in-agent).
