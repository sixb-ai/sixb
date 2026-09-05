# Authorization

Agents use the same [authorization](../auth/authorization.md) model as every other primitive.

## Conversational Agent

`run:agent` gates who may start the project Agent. Use the exported reference in a role:

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

Child agents inherit that same durable authority reference and revalidate it independently when
they start. Delegation therefore cannot widen the user's permissions.

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
- [Configure the Agent](./defining-agents.md) — project models, tools, and skills.
