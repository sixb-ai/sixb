# Tools and Authorization

Extend the built-in Agent with project tools and skills. Control project access through roles and groups.

## Custom tools

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

Register tools explicitly; they are not auto-discovered.

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { searchKnowledge } from "./agent-tools/search-knowledge"

export const sixb = createSixb({
  // ...providers, models, sandboxes
  tools: [searchKnowledge],
})
```

| Handler field | Use |
| --- | --- |
| `input` | Inferred tool input |
| `signal` | Cancellation |
| `connector` | Resolve a host-side connector; credentials stay off the model |
| `logger` | Run-scoped logs |
| `artifacts` | Publish files |
| `toolCallId`, `run` | Call and run metadata |

Return JSON-compatible data. Names must be unique; `bash`, `read`, `view_file`, `spawn_agent`, and `wait_agent` are reserved.

## Files from tools

```ts
import { type AgentToolResult, defineAgentTool } from "@sixb/core"

export const exportReport = defineAgentTool("export_report")
  .description("Export a report as a text file.")
  .input({ content: "string" })
  .run(async ({ input, artifacts }) => {
    const file = await artifacts.put({
      body: new TextEncoder().encode(input.content),
      fileName: "report.txt",
      mediaType: "text/plain",
    })

    return {
      kind: "agentToolResult",
      content: [{ type: "file", fileRef: file.fileRef }],
    } satisfies AgentToolResult
  })
```

| Artifact behavior | Limit / result |
| --- | --- |
| One file | 25 MB; safe single filename |
| All tools in a run | 100 MB combined, including concurrent calls |
| Storage | Durable `FileRef` plus a copy in the run sandbox |
| Conversation output | Promoted to assistant attachments; duplicate sandbox outputs removed |
| Images | Bounded model input when supported; otherwise metadata and sandbox path |

## Exa web tools

```bash
bun add @sixb/connector-exa
```

File: `connectors/exa.ts`

```ts
import { exa } from "@sixb/connector-exa"
import { defineConnector } from "@sixb/core"

export const exaConnector = defineConnector(
  "exa",
  exa({ apiKey: process.env.EXA_API_KEY! })
)
```

Add the tools to your project configuration:

```ts
import { exaWebFetch, exaWebSearch } from "@sixb/connector-exa/agent-tools"
import { exaConnector } from "./connectors/exa"

const allowedDomains = ["bun.com", "developer.mozilla.org"]

const tools = [
  exaWebSearch(exaConnector, { allowedDomains }),
  exaWebFetch(exaConnector, { allowedDomains }),
]
// createSixb({ ...yourConfig, tools })
```

| Tool | Model input | Default output | Timeout |
| --- | --- | --- | --- |
| `web_search` | `{ query }`, up to 2,000 characters | 5 results; 10,000 characters total | 20s |
| `web_fetch` | `{ url }`, one HTTP(S) URL | 10,000 characters; no crawling | 20s |

Both make one provider request without retry. Domain denials take precedence over allowances. Returned web content remains untrusted.

## Skills

```text
skills/
└── invoice-review/
    ├── SKILL.md
    └── references/
        └── examples.md
```

File: `skills/invoice-review/SKILL.md`

```md
---
name: invoice-review
description: Review invoices for missing details and payment discrepancies.
---

1. Compare the invoice with the linked purchase order.
2. Flag missing references or mismatched amounts.
3. Use references/examples.md for the expected report format.
```

Skill names and descriptions are advertised up front. The Agent reads full instructions when relevant; files are available under `$SIXB_SKILLS_DIR`. Sixb owns the baseline system prompt.

## Sandbox tools

| Tool | Input | Bounds |
| --- | --- | --- |
| `read` | Relative `path`, optional `offset`, `limit` | 2,000 lines or 50 KiB per call |
| `bash` | `command`, optional `cwd`, `timeoutMs` | 30s default, 120s maximum; output capped |
| `view_file` | Workspace file path | Publishes supported files through the artifact path |

Each run gets an isolated [sandbox](../sandboxes/overview.md). `read` rejects binary files and paths outside the workspace; `view_file` rejects symlinks and outside paths. Completed files placed in `$SIXB_OUTPUT_DIR` become final assistant attachments.

## Authorization

Grant access to the built-in Agent:

```ts
import { agent, can, defineRole } from "@sixb/core"
import { employees } from "../groups/employees"

export const assistantUser = defineRole("assistant.user", {
  grantedTo: [employees],
  grants: [can.run(agent)],
})
```

| Operation | Authority |
| --- | --- |
| Start a conversation turn | `can.run(agent)` plus current request credentials |
| Read/post/subscribe to a thread | Thread owner plus `can.run(agent)`; others see not-found |
| Use project data | Requester's current grants, revalidated when the turn starts |
| Run a workflow agent task | Workflow run grant; task uses its declared groups |
| Read costs or manage budgets | Separate [usage grants](./usage-and-limits.md#permissions) |

Authorization follows current memberships. Accounting retains the original requester and admitted group snapshot.

## Workflow tools and groups

```ts
import { defineAgentStep } from "@sixb/core"
import { finance } from "../security/groups/finance"
import { searchKnowledge } from "../agent-tools/search-knowledge"

const research = defineAgentStep("research", {
  instructions: "Research the request using trusted sources.",
  tools: [searchKnowledge],
  groups: [finance],
})
  .input({ question: "string" })
  .output({ answer: "string" })
  .prompt(({ input }) => input.question)
```

Each workflow agent step uses a managed service account with its declared groups. It needs no separate `can.run(agent)` grant. See [Workflows](../workflows/overview.md#define-agent-tasks).

## Gateway access

The sandbox's `sixb` CLI uses a run-scoped gateway. Access lasts only while the run is active and remains subject to authorization.

| Available | Examples |
| --- | --- |
| Project and ontology metadata | Project info, object types |
| Object reads | Queries, links, counts, facets, telemetry history |
| Actions | Discover, request, inspect runs |
| Workflows | Discover, request, inspect top-level input/output |
| Files | Simple uploads and authorized content downloads |

Generic object/link writes, telemetry append, administration, and workflow cancellation/interventions are outside the gateway. Domain-changing actions/workflows require confirmation; workflow agent tasks cannot start another workflow.

See [Authorization](../auth/authorization.md) for defining data grants and [Connectors](../data/connectors.md) for host-side integrations.
