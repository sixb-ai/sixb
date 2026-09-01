# AI usage limits

Sixb can stop Agent model calls when a project, group, user, or service account has no remaining
monthly capacity. Limits are enforced at the shared model-call boundary, so direct conversations
and workflow Agent nodes use the same rules.

## Supported limits

The first release supports two aggregate meters:

- `tokens.total` uses provider-reported total input and output tokens.
- `cost.catalogEstimated` uses Sixb's pinned Models.dev pricing catalog in USD. It is an estimate,
  not a provider invoice. Policies are fixed to USD because the built-in
  accounting path does not perform foreign-exchange conversion.

Periods are fixed UTC calendar months. Every matching enabled policy applies independently: a call
must fit the project policy, every snapshotted group policy, and its original user or service-account
policy. Editing, disabling, deleting, or recreating a policy does not reset the immutable usage and
cost ledgers.

There is no user-configurable maximum-output-token setting. Sixb reserves a conservative internal
output allowance before each call, then reconciles the reservation against actual provider usage.
A response can exceed its reservation; Sixb records the full amount and denies later calls after the
aggregate limit is exhausted.

## Authorization

AI accounting and current consumption require `can.observe("aiUsage")`. Reading policy definitions
requires either observation or the separate `can.manage("aiUsage")` grant, while policy changes
require management.

```ts
import { can, defineRole } from "@sixb/core"
import { financeAdmins } from "../groups/finance-admins"

export const aiUsageOperators = defineRole("ai-usage.operators", {
  grantedTo: [financeAdmins],
  grants: [can.observe("aiUsage"), can.manage("aiUsage")],
})
```

An observer can use Atlas and the status APIs without seeing mutation controls. A manager can list
and change policies in Atlas, but receives no consumption or accounting visibility unless the role
also grants observation. Atlas loads the registered groups, users, and service accounts through the
management grant and presents them as searchable selectors; operators never need to enter a subject
ID manually.

## API

The protected API surface is:

- `GET /api/ai/accounting/overview`
- `GET /api/ai/model-calls`
- `GET /api/ai/limits`
- `GET /api/ai/limits/status`
- `GET /api/ai/limits/subjects`
- `POST /api/ai/limits`
- `PUT /api/ai/limits/:limitId`
- `DELETE /api/ai/limits/:limitId`

Token amounts are non-negative safe integers. Cost amounts use exact nanounit strings:

```json
{
  "subject": { "type": "group", "id": "finance" },
  "limit": {
    "meter": "cost.catalogEstimated",
    "amount": { "currency": "USD", "amountNanos": "100000000000" }
  }
}
```

That example sets a monthly catalog-estimated limit of USD 100. Status responses distinguish actual,
reserved, unknown, and remaining amounts and report the next `resetAt`. Group policies whose group
definition disappeared are returned with `orphaned: true`.

## Enforcement and recovery

Before a provider request, Sixb estimates input tokens plus its conservative output allowance and
atomically reserves every applicable token and cost bucket. Concurrent workers cannot knowingly
reserve the same remaining capacity twice.

After the provider returns, immutable usage and valuation records are written and the reservation is
reconciled in the same storage transaction. Durable accounting recovery replays that reconciliation
idempotently after queue redelivery. Period totals are initialized from the immutable ledger once,
then maintained transactionally; routine admission does not rescan month-to-date records.

Sixb fails closed when an enabled meter cannot be evaluated safely:

- unknown model identity or unsupported pricing dimensions block a cost-limited call;
- incomplete token or valuation accounting blocks later admission;
- unavailable limit storage prevents Agent workers from starting;
- a provider attempt that may have been billed without usable actuals becomes `unknown` and retains
  capacity.

Denied calls use `ai.usage_limit_exceeded`; unsafe evaluation uses
`ai.usage_limit_unavailable`. Direct HTTP requests return 429, and exhausted responses include
`Retry-After` based on the earliest applicable reset.

## Provider billing caveat

Sixb limits its own admission decisions. Routed model identity, provider-side tokenization, failed
requests, and later billing adjustments can differ from the pre-call estimate. Keep provider budgets
enabled when invoice-level hard stops are required.
