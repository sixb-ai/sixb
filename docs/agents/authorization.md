# Authorization

Agents use the same [authorization](../auth/authorization.md) model as every other primitive.

## Main agent

`run:agent` gates who may start the main agent. Use the exported reference in a role:

```ts
import { agent, can, defineRole } from "@sixb/core"

export const assistantUser = defineRole("assistant.user", {
  grantedTo: [employees],
  grants: [can.run(agent)],
})
```

Each run inherits the user's durable request authority. The worker revalidates the session or access
token and current memberships before executing, so the agent never receives broader access than the
caller. When authentication is disabled, it follows the same unrestricted behavior as other API
requests.

## Defined agents

Existing agents created with `defineAgent` retain their managed service-account authority.

When authentication is disabled for the runtime, requests through the Agent API gateway follow the
same unrestricted authorization behavior as normal API requests. The group restrictions below
apply when authentication is enabled.

### Groups gate use and reach

An agent's `groups` (set on `defineAgent`) do two things:

- **Who can use it.** A principal can list and run an agent only if their grants cover it
  (`run:agent`). `GET /api/agents` returns only agents the caller may run; running one without the
  grant is rejected.
- **What it can reach.** A run acts under its own identity whose memberships mirror the agent's
  groups — so it can query the objects, read the telemetry, and request the actions its groups
  allow, and nothing else. Its instructions can ask for anything; only its permissions get through.

```ts
import { defineAgent, defineGroup } from "@sixb/core"
import { gateway } from "ai"

const financeAdmins = defineGroup("finance-admins")

export const invoiceAssistant = defineAgent("invoice-assistant", {
  name: "Invoice Assistant",
  model: gateway("openai/gpt-5.5"),
  instructions: "...",
  groups: [financeAdmins], // only finance admins can run it; it acts with their reach
})
```

Every referenced group must exist in your security registry (`security/groups/` or
`createSixb({ groups })`), or startup fails.

## Threads are owner-scoped

A thread records the principal that created it. Reading it, posting to it, and subscribing to its
stream all require that owner (plus the `run:agent` grant). Anyone else sees it as not-found.

The run API exposes `requestedBy`, resolved from its immutable execution record. Authority is stored
on that execution record rather than copied onto the run.

## Related

- [Authorization](../auth/authorization.md) — defining groups, roles, and grants.
- [Defining agents](./defining-agents.md) — set `groups` on an agent.
