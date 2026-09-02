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

### Run grants gate use

A principal can list and run an agent only if their grants cover it (`run:agent`).
`GET /api/agents` returns only agents the caller may run; running one without the grant is rejected.

### Groups gate reach

A run acts under its own identity whose memberships mirror the agent's `groups`. It can only reach
the objects, telemetry, actions, and other capabilities those groups allow.

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

## Workflow agent tasks

Starting the workflow is authorized by `run:workflow`; an agent task is not independently runnable
and needs no `run:agent` grant. Sixb gives each workflow step a stable managed service account whose
memberships mirror `defineAgentStep({ groups })`. The workflow requester remains the execution's
original attribution, but the task acts only with its own declared reach.

## Threads are owner-scoped

A thread records the principal that created it. Reading it, posting to it, and subscribing to its
stream all require that owner (plus the `run:agent` grant). Anyone else sees it as not-found.

The run API exposes `requestedBy`, resolved from its immutable execution record. Authority is stored
on that execution record rather than copied onto the run.

## Related

- [Authorization](../auth/authorization.md) — defining groups, roles, and grants.
- [Defining agents](./defining-agents.md) — set `groups` on an agent.
