# Agents

An agent is a conversational, looping assistant you define alongside your ontology. It holds a
conversation, calls a language model, runs a sandboxed `bash` tool, and reads your project's own
objects, actions, and telemetry through a scoped API. Reach for an agent when a person needs to ask
questions of — or act on — your domain in natural language.

You define an agent declaratively and export it from `agents/`; `createSixb()` discovers it. A
worker runs it, and clients drive it over HTTP and a websocket.

## Define an agent

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
| **Definition** | The agent you write with `defineAgent` — model, instructions, groups, loop limits. |
| **Thread** | One conversation with an agent, owned by a principal. |
| **Run** | One turn. Posting a user message triggers a run. |
| **Message** | A `system`, `user`, or `assistant` message made of `text`, `reasoning`, `step-start`, and `tool-call` parts. |
| **Tools** | A built-in `bash` tool (in a [sandbox](../sandboxes/overview.md)) and scoped access to your object/action/telemetry API. |

## Run an agent

Defining an agent needs nothing extra. **Running** one needs two things:

- The **agent-worker** process. `bun sixb dev` runs it for you; in production run it like the other
  workers.
- A **sandbox factory** — `createSixb({ sandboxes })`. The worker won't start without one, because
  the `bash` tool runs in a sandbox.

```ts
import { createSixb } from "@sixb/core"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"

export const sixb = createSixb({
  id: "acme-corp",
  // ...storage, broker, queues
  sandboxes: new SmolvmSandboxFactory(),
})
```

A turn then runs end to end: the worker loads the thread, calls the model with streaming, runs any
`bash` tool calls in the sandbox, and persists the assistant reply when the model stops. Clients
follow it live over the websocket — see [Running and streaming](./running-and-streaming.md).

## Related

- [Defining agents](./defining-agents.md) — the `defineAgent` config.
- [Running and streaming](./running-and-streaming.md) — threads, the HTTP API, and the websocket.
- [Tools and gateway](./tools-and-gateway.md) — the bash tool and scoped data access.
- [Authorization](./authorization.md) — gate who can use an agent and what it can reach.
- [Sandboxes](../sandboxes/overview.md) — where the bash tool runs.
