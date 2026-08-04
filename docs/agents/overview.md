# Agents

An agent is a conversational assistant you define alongside your ontology. It calls a language
model, selected worker tools, sandboxed `bash`, and a scoped Sixb API.

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
| **Definition** | The agent you write with `defineAgent` — model, instructions, groups, selected tools, and loop limits. |
| **Thread** | One conversation with an agent, owned by a principal. |
| **Run** | One turn. Posting a user message triggers a run. |
| **Message** | A `system`, `user`, or `assistant` message made of `text`, `reasoning`, `step-start`, and `tool-call` parts. |
| **Tools** | Explicitly selected worker tools plus built-in `bash` in a [sandbox](../sandboxes/overview.md). |

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

For each turn, the worker offers that agent's selected tools plus `bash`, executes them in their
respective boundaries, and persists the reply. See
[Running and streaming](./running-and-streaming.md).

## Related

- [Defining agents](./defining-agents.md) — the `defineAgent` config.
- [Running and streaming](./running-and-streaming.md) — threads, the HTTP API, and the websocket.
- [Tools and gateway](./tools-and-gateway.md) — selected worker tools, connector-backed web access,
  sandboxed `bash`, and scoped data access.
- [Authorization](./authorization.md) — gate who can use an agent and what it can reach.
- [Sandboxes](../sandboxes/overview.md) — where the bash tool runs.
