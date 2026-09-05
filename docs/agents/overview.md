# Agents

Sixb provides one conversational Agent. It calls a project language model, project tools,
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
When authentication is enabled, the Agent inherits the requesting user's current authority.
The chat composer lists the configured models, their known capabilities, and supported reasoning
levels. The selected values apply to the next turn and are stored on its durable run.
Display metadata is refreshed from Models.dev through a bounded in-memory cache. The API falls back
to its embedded snapshot if the service is unavailable and never adds models to the project catalog.

## Child agents

The Agent can delegate focused tasks to headless child agents. It can choose any language
model configured in `models.language`, continue working after a child starts, and wait only when it
needs the result. Children are created at runtime; no extra
project configuration is required.

Each child:

- inherits and independently revalidates the parent's durable authority;
- receives all project tools plus an isolated sandbox and scoped Sixb API access;
- owns a durable run, usage records, stream, and isolated sandbox, but no conversation thread;
- is cancelled if its parent finishes while it is still active.

Up to four children may be active per parent run. They execute on a separate worker lane so waiting
parents cannot consume their capacity. Child agents cannot delegate again or start workflows in
this first version.

When several models are configured, the Agent sees the default, base input/output prices, and
context limits from Sixb's pinned Models.dev catalog when available. Runtime speed is not guessed;
the default remains the fallback when there is no clear reason to select another model.

## Workflow tasks

Use `defineAgentStep` for structured background work within a workflow. Its prompt, inputs, output
schema, and execution groups belong to the step. See [Workflows](../workflows/overview.md).

## Core concepts

| Concept | What it is |
| --- | --- |
| **Agent** | The framework-owned conversational entry point, enabled by the project model catalog. |
| **Thread** | One conversation with the Agent, owned by a principal. |
| **Run** | One turn. Posting a user message triggers a run. |
| **Message** | A `system`, `user`, or `assistant` message made of `text`, `reasoning`, `step-start`, and `tool-call` parts. |
| **Tools** | Project tools plus `read`, `view_file`, and `bash`; the Agent also gets `spawn_agent` and `wait_agent`. |

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

- [Configure the Agent](./defining-agents.md) — models, tools, and skills.
- [Running and streaming](./running-and-streaming.md) — threads, the HTTP API, and the websocket.
- [Tools and gateway](./tools-and-gateway.md) — selected worker tools, connector-backed web
  access, sandboxed file and command access, and scoped data access.
- [Authorization](./authorization.md) — gate who can use an agent and what it can reach.
- [Sandboxes](../sandboxes/overview.md) — where the sandbox tools run.
