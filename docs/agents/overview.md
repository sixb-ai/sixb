# Agents

Sixb provides one main conversational agent. It calls a project language model, project tools,
sandboxed `read` and `bash`, and an authorized Sixb API.

Configure at least one language model to enable it. The first model is the default.

```ts
import { createSixb, defineAgentTool } from "@sixb/core"
import { gateway } from "ai"

const lookup = defineAgentTool("lookup")
  .description("Look up project data.")
  .input({ query: "string" })
  .run(async ({ input }) => ({ results: await search(input.query) }))

export const sixb = createSixb({
  models: {
    language: [gateway("openai/gpt-5.5"), gateway("anthropic/claude-sonnet-4.6")],
  },
  tools: [lookup],
})
```

The agent worker runs each turn through the existing durable run, stream, and sandbox lifecycle.
When authentication is enabled, the main agent inherits the requesting user's current authority.

## Defined agents

`defineAgent` remains temporarily available for existing conversational agents. New workflow agent
tasks are configured directly with `defineAgentStep`; see [Workflows](../workflows/overview.md).

Put each definition in `agents/` and export it.

```ts
// agents/business-analyst.ts
import { defineAgent } from "@sixb/core"
import { gateway } from "ai"

export const businessAnalyst = defineAgent("business-analyst", {
  name: "Business Analyst",
  description: "Investigates customers, invoices, projects, and follow-ups.",
  model: gateway("deepseek/deepseek-v4-flash"),
  instructions: [
    "You are the business operations analyst for this project.",
    "Ground answers in the data available through Sixb, and say when data is insufficient.",
    "Prefer concise summaries with clear next actions.",
  ].join("\n"),
})
```

See [Defining agents](./defining-agents.md) for every config field.

## Core concepts

| Concept | What it is |
| --- | --- |
| **Main agent** | The framework-owned conversational entry point, enabled by the project model catalog. |
| **Defined agent** | A transitional `defineAgent` configuration for existing conversations. |
| **Thread** | One conversation with an agent, owned by a principal. |
| **Run** | One turn. Posting a user message triggers a run. |
| **Message** | A `system`, `user`, or `assistant` message made of `text`, `reasoning`, `step-start`, and `tool-call` parts. |
| **Tools** | Project tools plus built-in `read` and `bash` in a [sandbox](../sandboxes/overview.md). |

## Run an agent

**Running** an agent needs two things:

- The **agent-worker** process. `bun sixb dev` runs it for you; in production run it like the other
  workers.
- A **sandbox factory** — `createSixb({ sandboxes })`. The worker won't start without one, because
  the `read` and `bash` tools run in a sandbox.

```ts
import { createSixb } from "@sixb/core"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"

export const sixb = createSixb({
  id: "acme-corp",
  // ...storage, broker, queues
  sandboxes: new SmolvmSandboxFactory(),
})
```

For each turn, the worker offers that agent's configured tools plus `read` and `bash`, executes them
in their respective boundaries, and persists the reply. See
[Running and streaming](./running-and-streaming.md).

## Related

- [Defining agents](./defining-agents.md) — the `defineAgent` config.
- [Running and streaming](./running-and-streaming.md) — threads, the HTTP API, and the websocket.
- [Tools and gateway](./tools-and-gateway.md) — selected worker tools, connector-backed web
  access, sandboxed file and command access, and scoped data access.
- [Authorization](./authorization.md) — gate who can use an agent and what it can reach.
- [Sandboxes](../sandboxes/overview.md) — where the sandbox tools run.
