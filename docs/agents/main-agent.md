# The main agent

Most projects want one assistant to talk to, not a picker. Configure a **main agent** and it becomes
that entrypoint: users address it, and it hands specialist work to the agents you defined with
`defineAgent`.

```ts
import { createSixb } from "@sixb/core"
import { gateway } from "ai"

export const sixb = createSixb({
  id: "acme-corp",
  mainAgent: {
    name: "Assistant",
    model: gateway("openai/gpt-5.5"),
    instructions: "Answer directly when you can. Delegate specialist work to the right agent.",
  },
  // ...storage, broker, queues, sandboxes
})
```

The main agent is managed by the framework. It is registered under the reserved id `main`, so a
project agent may not also claim that id while `mainAgent` is configured.

## Config

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Display name. |
| `model` | `LanguageModelV4` | Yes | An AI SDK model instance. |
| `instructions` | `string` | Yes | The system prompt. |
| `description` | `string` | No | Short summary for catalogs. |
| `reasoning` | reasoning level | No | Same values as `defineAgent`. |
| `providerOptions` | provider-keyed object | No | Per-provider passthrough. |
| `loop` | `{ stopWhen?: { maxSteps?: number } }` | No | Step cap per turn. Defaults to **25**. |

There is deliberately no `tools` and no `groups`. The main agent gets exactly one tool —
`sub_agent` — and reaches other agents through the *requester's* permissions rather than its own.

## `sub_agent`

Every agent the requester is allowed to run is offered to the main agent automatically. There is no
allow-list to maintain.

```text
User request
  └── main — its own service account, no groups
        └── sub_agent("invoice-assistant", task)
              └── invoice-assistant — own service account, own groups, own sandbox
```

A delegated run is a real run: its own `agent_run`, its own execution linked to the parent through
`source.executionId`, its own service account and sandbox, and its own rows in the model-call
ledger. It runs on its own thread, owned by the main agent, so it does not appear in the user's
thread list.

Only the main agent receives `sub_agent`. A specialist cannot delegate onward, so delegation is one
level deep by construction.

## Permissions

Before starting a delegated run, `sub_agent` checks the **requester's** `run:agent` grant on the
target — the same grant that governs running that agent directly from the API. An agent a user could
not open a thread with is not offered to the main agent and cannot be reached through it.

The main agent has no groups of its own, so it holds no grants: it routes, and the specialists it
calls are what actually reach your data. Give each specialist the groups its work needs.

```ts
import { can, defineRole, every } from "@sixb/core"

const assistantUsers = defineRole("assistant.users", {
  grantedTo: [everyone],
  grants: [can.run(every.agent())],
})
```

> Granting `run:agent` on the main agent alone is not currently expressible — `can.run` takes a
> definition object, and the main agent's definition is framework-owned. Use `every.agent()` for
> now.

## Limits in this release

- **Delegated runs are at-least-once.** A redelivered main-agent turn replays its history and may
  re-issue the same delegation.
- **A delegated run has no queue job.** If the worker dies mid-delegation, the child run stays
  `running` — inert, since its thread is single-use and not listed anywhere, but not swept.
- **Usage is per execution.** Each delegated run's cost is recorded against its own execution; the
  main agent's run reports only its own.
- **The UI shows the call, not the child.** You see the `sub_agent` tool call and its result; the
  child's own token stream is not surfaced.

## Related

- [Defining agents](./defining-agents.md) — the specialists `sub_agent` calls.
- [Authorization](./authorization.md) — groups, grants, and thread ownership.
- [Tools and gateway](./tools-and-gateway.md) — the other framework-injected tool, `bash`.
