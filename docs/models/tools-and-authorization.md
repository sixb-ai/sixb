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
  .run(async ({ input, signal, sixb }) => {
    const knowledge = await sixb.connector(knowledgeConnector)
    return knowledge.search(input.query, { signal })
  })
```

The input schema validates arguments from the model. Return JSON-compatible data, and pass
`signal` to requests that support cancellation. Resolving a [connector](../connectors/overview.md)
in the handler keeps its credentials on the server.

What the handler returns is the tool's output: the chat saves and streams it as is, and
`InferAgentToolOutput` gives its type to the code that renders it:

```ts
type SearchResults = InferAgentToolOutput<typeof searchKnowledge>
```

## Use project data in a tool

A tool is one specific operation that has to run on the server, such as a call to an API whose
key stays there; reading and searching data is work the agent does on its own. In the handler,
`sixb` reads objects and requests actions as the requester, and `attachments.open(key)` opens a
file of the run by the key the agent sees in `$SIXB_ATTACHMENTS`:

File: `agent-tools/extract-document.ts`

```ts
import { AgentToolPublicError, defineAgentTool } from "@sixb/core"
import { documentExtraction } from "../connectors/document-extraction"

export const extractDocument = defineAgentTool("extract_document")
  .description("Extract the text and tables of an attachment. Pass its key.")
  .input({ key: "string" })
  .run(async ({ input, signal, sixb, attachments }) => {
    const file = await attachments.open(input.key)
    if (!file) throw new AgentToolPublicError("The attachment is no longer available.")
    const extraction = await sixb.connector(documentExtraction)
    const { text, tables } = await extraction.extract(file.body, {
      fileName: file.fileRef.fileName,
      signal,
    })
    return { text, tables }
  })
```

| Run | Permissions |
| --- | --- |
| Chat | The signed-in user's. |
| [Sub-agent](./overview.md#it-delegates) | The parent chat's user's. |
| Workflow AI task | Those granted through the step's `groups`. |

An action a tool requests runs at once, whatever the user's
[approval mode](./overview.md#approve-what-the-agent-changes): Sixb does not ask them first.

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
Data read through `sixb` is already limited to the requester's permissions; also limit what the
tool returns from connectors and other sources to what its users should see.

## Show a tool in the chat

The chat shows a tool's calls as a generic row in its work. To show them your way, define a view
in `app/`, typed with the tool's definition. Import the tool as a type, so it stays on the server:

File: `app/_agent/search-results-view.tsx`

```tsx
import { defineAgentToolView } from "@sixb/app"
import type { searchKnowledge } from "../../agent-tools/search-knowledge"

export const searchResultsView = defineAgentToolView<typeof searchKnowledge>("search_knowledge", {
  placement: "answer",
}).render(({ state, input, output }) => {
  if (state === "output-error") return null
  if (state === "output-available") return <Results results={output} />
  return <Searching query={input?.query} />
})
```

Then export your views from `app/layout.tsx`, the way `sixb.config.ts` lists the tools:

File: `app/layout.tsx`

```tsx
export const toolViews = [searchResultsView]
```

| `placement` | Where the view shows |
| --- | --- |
| `"work"` (default) | In place of the tool's row, inside the reply's work. |
| `"answer"` | After the reply's text, in call order. The work keeps the tool's row. |

- `state` is `"input-streaming"`, `"input-available"`, `"output-available"` or `"output-error"`.
  `input` is typed from the tool's input once it is complete, and `output` once the call
  succeeded. A failed call has `errorText`, and its `input` is `unknown`: when the input is why it
  failed, it is what the model sent.
- The view renders as a React component, so it can use hooks. If it throws, the chat shows the
  tool's own row instead.
- A tool name the definition does not have is a type error. Views apply to every chat in the app.

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
reads the full instructions when relevant. Supporting files, such as references or scripts, can
live alongside `SKILL.md` and be referenced by relative path.

The chat agent can use every skill. An [AI workflow step](../workflows/overview.md#add-an-ai-task)
uses only the skills it lists in `skills`.

Skills guide behavior; they do not grant access. Domain operations still follow the agent's
[permissions](./overview.md#control-access).
