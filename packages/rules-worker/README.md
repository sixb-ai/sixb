# @sixb/rules-worker

Evaluates Rules against current committed ontology state.

```text
live object/link events ---------------------------\
                                                    -> one serialized evaluation coordinator
reconciliation: at startup and after a failure ----/
```

Events are wake-up facts. The worker always re-reads `storage.objects`; it never overlays historical
event payloads onto current state.

Every effective object and link change commits together with its event in the ontology outbox,
which publishes the event at least once. While the worker runs, it can miss a change only when an
evaluation fails. So it reads all current state only then and at startup (which covers changes made
while it was stopped and changed definitions), retrying a failed pass with backoff (0.1 s doubling
up to 60 s) until one succeeds. An idle worker does no work.

## Guarantees

- subscribes before startup reconciliation;
- evaluates affected live subjects in order;
- reconciles at startup and after any failed evaluation, never on a timer;
- never overlaps live evaluation and reconciliation;
- pages objects by stable primary-ID keyset and loads referenced links in batch;
- scans active `rule_states` so deleted subjects resolve;
- emits `rule.triggered` / `rule.resolved` only when active state changes;
- drains accepted work during shutdown.

Delivery is at-least-once. A crash around event/state persistence may produce a duplicate Rule event;
consumers must tolerate it. V1 supports one active Rules worker per project and adds no Rule lease or
heartbeat.

## Hosting

The CLI hosts the worker automatically when Rules are registered. Custom hosts can configure the
reconciliation page size:

```ts
import { RulesWorker } from "@sixb/rules-worker"

const worker = new RulesWorker(sixb, { reconciliationPageSize: 500 })

await worker.start()
await worker.stop()
```

The runtime must expose author-facing Events operations, Object/Rule storage, and registered Rule
definitions. Construction fails when no Rule exists or `storage.rules` is unavailable.

## Development

```bash
bun --filter @sixb/rules-worker typecheck
bun test packages/rules-worker/tests
bun --filter @sixb/rules-worker build
```
