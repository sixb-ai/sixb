# @sixb/rules-worker

Evaluates Rules against current committed ontology state.

```text
live object/link events ----\
                             -> one serialized evaluation coordinator
periodic reconciliation ----/
```

Events are wake-up facts. The worker always re-reads `storage.objects`; it never overlays historical
event payloads onto current state.

## Guarantees

- subscribes before startup reconciliation;
- evaluates affected live subjects in order;
- reconciles once at startup, then every 60 seconds by default;
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
reconciliation interval and page size:

```ts
import { RulesWorker } from "@sixb/rules-worker"

const worker = new RulesWorker(sixb, {
  reconciliationIntervalMs: 60_000,
  reconciliationPageSize: 500,
})

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
