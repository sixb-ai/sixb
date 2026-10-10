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

## Read project data

The handler's `sixb` reads objects, telemetry, and datasets, and changes data through
`sixb.actions`, which validate and record each change. It also offers `models` and `connector`.
Object sets have the same reads as in a workflow step, without the writes. To return a file,
publish it with `artifacts`. This tool finds a project by name:

File: `agent-tools/find-project.ts`

```ts
import { defineAgentTool } from "@sixb/core"
import { Project } from "../ontology/project"

export const findProject = defineAgentTool("find_project")
  .description("Find a project by name and return its budget.")
  .input({ name: "string" })
  .run(async ({ input, sixb }) => {
    const project = await sixb
      .objects(Project)
      .query()
      .where((p) => p.p.name.eq(input.name))
      .first()
    if (!project) return { found: false }
    return { found: true, id: project.properties.id, budget: project.properties.budget ?? null }
  })
```

Unlike a workflow step, which runs with trusted access, a tool acts with the permissions of the
run that called it:

| Run | Permissions |
| --- | --- |
| Chat | The signed-in user's. |
| Child agent (delegation is currently disabled) | The parent chat's user's. |
| Workflow AI task | Those granted through the step's `groups`. |

The tool sees exactly what that requester may see: an object type or dataset they cannot view
throws an `AuthorizationError`, and properties and columns [marked](../auth/markings.md) beyond
their clearance are left out. Model calls count toward the agent run's
[usage and limits](./usage-and-limits.md).

A tool that requests an action runs it immediately. The agent asks the user to confirm a domain
change before it requests one itself; actions a tool requests skip that confirmation, so request
only changes the model may make on its own.

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
[permissions](./overview.md#control-access).
