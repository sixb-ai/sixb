# Authorization

Agents touch the same data and actions as everyone else, so the same
[authorization](../auth/authorization.md) model governs them. Two things decide what an agent can do:
the **groups** on its definition and the **owner** of each thread.

## Groups gate use and reach

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

Each run records both principals: `requestedByPrincipal` (who triggered it) and `executionPrincipal`
(the identity it ran as).

## Related

- [Authorization](../auth/authorization.md) — defining groups, roles, and grants.
- [Defining agents](./defining-agents.md) — set `groups` on an agent.
