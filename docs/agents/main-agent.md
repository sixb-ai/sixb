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
`sub_agent` — and it does not need groups because it **runs with the authority of whoever is talking
to it**. See [Permissions](#permissions).

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

**The main agent runs as you.** Its execution carries the requesting user as its authority, so every
object it queries, every action it requests, and every agent it delegates to is bounded by that
user's own grants. Two people talking to the same assistant see exactly what each of them is allowed
to see, from one definition with no groups on it.

```text
Ada asks the assistant                Bob asks the assistant
  └── runs as Ada                       └── runs as Bob
        └── reaches Ada's data                └── reaches Bob's data
```

This is why `mainAgent` takes no `groups`: giving it a fixed identity would flatten every user's
reach into one. Every other agent still acts under its own managed service account, exactly as
before.

This extends to the [sandbox](../sandboxes/overview.md). The main agent's `bash` tool calls the Sixb
API through a run-scoped gateway, and those calls now carry the user's authority too — so a command
the model writes can read and act on exactly what that user could, and nothing more. The gateway's
route allow-list still bounds *which* endpoints are reachable at all.

The reach is the *effective* one. If a request authenticated with an access token scoped to a subset
of the user's groups, the main agent inherits that narrower set — a scoped token cannot be widened by
routing work through an agent. A run whose requester is suspended after admission is refused rather
than replayed.

Delegation follows the same rule: before starting a child run, `sub_agent` checks the requester's
`run:agent` grant on the target, which is the same grant that governs running that agent directly.
An agent the user could not open a thread with is never offered to the main agent. The **child** then
runs under its own service account and groups — delegation does not hand the user's identity onward.

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

A main-agent turn started with no human behind it (a schedule, a system trigger) falls back to its
own service account, which has no groups and therefore no grants. That is deliberate: unattended
work does not silently inherit anyone's authority.

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
