# Usage accounting

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## Enforcement and recovery

Before a provider request, Sixb estimates input tokens plus its conservative output allowance and
atomically reserves every applicable token and cost bucket. Concurrent workers cannot knowingly
reserve the same remaining capacity twice.

After the provider returns, immutable usage and valuation records are written and the reservation is
reconciled in the same storage transaction. Durable accounting recovery replays that reconciliation
idempotently after queue redelivery. Period totals are initialized from the immutable ledger once,
then maintained transactionally; routine admission does not rescan month-to-date records.
An incomplete period is refreshed from the ledger on the next status read or admission attempt.
When a missing valuation arrives, actual consumption and accounting availability recover without
resetting active or unknown reservations. Partial repairs continue to block admission.

Sixb fails closed when an enabled meter cannot be evaluated safely:

- unknown model identity or unsupported pricing dimensions block a cost-limited call;
- incomplete token or valuation accounting blocks later admission;
- unavailable limit storage prevents Agent workers from starting;
- a provider attempt that may have been billed without usable actuals becomes `unknown` and retains
  capacity.

Cost admission uses `model.costEstimator.estimateReservation`. The Anthropic and Vercel Gateway
integrations reserve using their existing rate cards, including cache-write rates and pricing tiers.
Ordinary Anthropic calls need no separate cache-TTL accounting option; both five-minute and one-hour
cache rates are supported. Custom models without a reservation estimator can use token limits,
but cost-limited calls fail closed until a safe estimate is available.

Denied calls use `ai.usage_limit_exceeded`; unsafe evaluation uses
`ai.usage_limit_unavailable`. Direct HTTP requests return 429, and exhausted responses include
`Retry-After` based on the earliest applicable reset.

## Recovery-only operation

The agent queue also carries accounting recovery for direct language and embedding calls.
`AgentWorker` handles these jobs before requiring an agent execution context, using the host's
accounting storage. Replays reconcile the ledger and reservations without calling a model.

Without a configured language catalog or workflow agent nodes, the worker drains recovery jobs
without initializing agent tools or requiring a sandbox or API origin. The CLI uses that distinction
for startup validation and selects this worker when embedding models are registered.

See [model execution accounting](../../core/src/models/execution/README.md) for the producer flow.
