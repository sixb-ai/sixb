# @pario/rules-worker

Event-driven worker for evaluating Pario rules against object state.

The rules worker subscribes directly to ontology events and evaluates only the
rules affected by each event. It does not use queues or orchestrator routes:
rules describe object state, so the worker reacts to object/link changes as they
arrive.

## Responsibilities

- subscribe to `object.upserted`, `link.upserted`, and `link.removed`
- match each ontology event to the rules that depend on it
- evaluate only the affected subject object
- overlay the source event onto projected object/link storage before evaluation
- emit `rule.triggered` when a matching rule has no active state
- emit `rule.resolved` when a previously active rule no longer matches
- store active violation state in `storage.rules`
- drain accepted evaluations during shutdown

## Usage

Most projects should use the CLI host. When rules are registered, `pario dev`
and `pario start` co-host the worker automatically:

```ts
const pario = createPario({
  ontology: [Transaction, Document],
  rules: [requiresDocumentRule],
})
```

The CLI starts the rules worker before functions, the orchestrator, sync worker,
and scheduler so it is already subscribed before local producers emit ontology
events.

For tests or custom hosts:

```ts
import { RulesWorker } from "@pario/rules-worker"

const worker = new RulesWorker(pario)

await worker.start()
// ... worker is now consuming object/link events
await worker.stop()
```

The runtime passed to `RulesWorker` must provide:

```ts
{
  id: string
  events: EventsRuntime
  storage: Storage // including storage.rules
  getRuleDefinitions(): readonly RuleDefinition[]
  getRuleById(ruleId: string): RuleDefinition | null
}
```

The constructor throws when no rules are registered or when `storage.rules` is
missing.

## Evaluation Flow

For each received ontology event batch:

1. Build candidate evaluations from the precomputed rule dependency index.
2. Dedupe by `ruleId + subject` within the batch.
3. Load the subject object from `storage.objects`.
4. Overlay any matching `object.upserted` payloads from the accepted events.
5. Load only the outgoing links referenced by the rule predicate.
6. Overlay matching `link.upserted` and `link.removed` payloads.
7. Evaluate the rule predicate against the overlaid object/link view.
8. Check `storage.rules` for active state.
9. Append and apply `rule.triggered` or `rule.resolved` only when state changes.

This keeps live evaluation scoped to the affected object. The worker never scans
all objects in response to an event.

## Projection Timing

Object and link writes append to the events runtime before storage projection is
guaranteed to be visible. A direct events subscriber therefore cannot assume
`storage.objects` already includes the event it is handling.

The rules worker stays correct by evaluating with an in-memory overlay:

- if projection has not caught up, the overlay supplies the new object/link state
- if projection has already caught up, the overlay produces the same effective
  state

This makes rule evaluation idempotent with respect to projection timing.

## Delivery Contract

The current `EventsRuntime.subscribe(...)` API has no acknowledgement, retry, or
dead-letter mechanism. The V1 rules worker is therefore live-only:

- events appended before the worker starts are not replayed
- evaluation batches are processed sequentially through a local promise chain
- evaluation errors are logged with `[ParioRulesWorker]`
- later event batches keep processing after an error
- `stop()` unsubscribes first, then waits for already accepted evaluations to
  finish

Durable retry, catch-up, reconciliation, and backfill should be added through a
future event consumer contract or a separate replay/backfill command.

## Development

```bash
bun --filter @pario/rules-worker typecheck
bun test packages/rules-worker/tests/evaluate-predicate.test.ts
bun test packages/rules-worker/tests/evaluate-rule-event.test.ts
bun test packages/rules-worker/tests/worker.test.ts
bun --filter @pario/rules-worker build
```
