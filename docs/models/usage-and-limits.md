# Usage and limits

Direct generation, conversations, and workflow agent tasks share model-call accounting and monthly limits.

## Automatic accounting

```text
Check limits → Reserve capacity → Call provider
                                      ↓
                         Store usage + cost + actuals
                                      ↓
                           Return / validate output
```

```ts
const { usage, cost, callId } = await sixb.models.language.generate({
  prompt: "Summarize: ...",
})

usage.inputTokens  // number | undefined
usage.outputTokens // number | undefined
cost.status        // "rated" | "reported" | "unpriceable"
```

| Evidence | Stored valuation |
| --- | --- |
| Provider-reported charge | Selected cost; local estimate retained separately |
| Local rate-card estimate | Selected cost with quantities, rates, and components |
| Insufficient usage or pricing | `unpriceable`, with a reason |
| Interrupted accepted stream | Available identifiers and unknown final meters |

Stored priced valuations use `status: "rated"`; their price source distinguishes provider reports from estimates. Totals count each call once. Unknown usage or cost is never zero.

```jsonc
{ "currency": "USD", "amountNanos": "1250000" } // $0.00125
```

## Read model calls

In Atlas, open **AI usage → Model calls**. Server-side integrations can read the ledger:

```ts
const page = await host.storage.aiCosts!.listModelCalls({
  projectId: host.id,
  from: new Date("2026-09-01T00:00:00Z"),
  to: new Date("2026-10-01T00:00:00Z"),
})

for (const call of page.items) {
  console.log(call.usage.callId, call.usage.usage, call.cost)
}
```

| HTTP endpoint | Returns |
| --- | --- |
| `GET /api/ai/accounting/overview` | Project accounting totals |
| `GET /api/ai/model-calls` | Paginated calls; filter by `executionId` for one execution |
| `GET /api/ai/model-call-groups` | Execution groups for requests, actions, workflows, and Agents; includes matching subagent calls |

Date, provider, model, and valuation filters apply to calls. Native provider identifiers are retained when supplied.

## Monthly limits

Every enabled policy matching the project, requester, or admitted requester groups must allow the call.

| Meter | Amount |
| --- | --- |
| `tokens.total` | Non-negative safe integer: input + output tokens |
| `cost.catalogEstimated` | Exact USD nanounits |

Periods are UTC calendar months. Changing or recreating a policy does not reset recorded consumption.

Requester groups are captured on the durable execution at admission. Child executions inherit that snapshot; worker redeliveries reuse it. A new user-requested run gets a new admission snapshot. Authorization still checks current permissions.

```jsonc
// POST /api/ai/limits — $100/month for the finance group
{
  "subject": { "type": "group", "id": "finance" },
  "limit": {
    "meter": "cost.catalogEstimated",
    "amount": { "currency": "USD", "amountNanos": "100000000000" }
  }
}
```

```jsonc
// POST /api/ai/limits — 1 million tokens/month for the project
{
  "subject": { "type": "project" },
  "limit": { "meter": "tokens.total", "amount": 1000000 }
}
```

| HTTP endpoint | Purpose |
| --- | --- |
| `GET /api/ai/limits` | List policies |
| `GET /api/ai/limits/status` | Actual, reserved, unknown, remaining capacity, and `resetAt` |
| `GET /api/ai/limits/subjects` | Find groups, users, and service accounts |
| `POST /api/ai/limits` | Create a policy |
| `PUT /api/ai/limits/:limitId` | Change its amount or enabled state |
| `DELETE /api/ai/limits/:limitId` | Delete a policy |

## Permissions

The current permission reference is `agent.usage`; it covers accounting for all model calls.

```ts
import { agent, can, defineRole } from "@sixb/core"
import { financeAdmins } from "../groups/finance-admins"

export const aiUsageOperators = defineRole("ai-usage.operators", {
  grantedTo: [financeAdmins],
  grants: [can.observe(agent.usage), can.manage(agent.usage)],
})
```

| Grant | Access |
| --- | --- |
| `can.observe(agent.usage)` | Accounting, consumption, policy definitions |
| `can.manage(agent.usage)` | Policy definitions, subject lookup, policy changes |
| `can.run(agent)` | Conversation access; no accounting or policy-management access |

## Admission and failures

| Condition | Result |
| --- | --- |
| Insufficient remaining capacity | `ai.usage_limit_exceeded` |
| Missing safe estimate, incomplete accounting, or unavailable limit storage | `ai.usage_limit_unavailable` |
| Ambiguous billed attempt | Capacity remains reserved as unknown until reconciled |
| Concurrent calls | Reserve capacity atomically |

HTTP limit errors return `429`; exhausted responses include `Retry-After`.

Reservations estimate input plus the request's output allowance. Actual usage can exceed that estimate; Sixb records the full amount and blocks later calls when capacity is exhausted. Per-call ceilings are configured separately through [`maxOutputTokens`](./generation.md).

Cost limits require `model.costEstimator.estimateReservation`. Built-in providers supply it; custom models without it can use token limits. The cost meter reserves local estimates and records the selected call valuation, including provider charges when available.

## Recovery

Usage, valuation, actuals, and reservation reconciliation are written atomically. Recovery replays are idempotent.

| Deployment | Recovery consumer |
| --- | --- |
| `bun sixb dev` / CLI cohosting | The configured Agent worker handles recovery |
| Embedded | Start `AgentWorker` with the project's agent configuration |

```ts
import { AgentWorker } from "@sixb/agent-worker"

const worker = new AgentWorker(host, { apiBaseUrl: "http://localhost:3002" })
await worker.start()

// During shutdown:
await worker.stop()
```

Recovery jobs share `queues.agents` with agent work. `generate()` calls providers directly; only deferred accounting enters the queue. See [Built-in Agent](./built-in-agent.md) for worker setup.

The ledger covers accepted streams. Pre-stream failures and process crashes before recording can leave billing outside its guarantees. Sixb limits are admission controls, not provider-invoice hard stops.
