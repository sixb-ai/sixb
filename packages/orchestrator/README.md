# @sixb/orchestrator

Routes runtime events to primitive dispatchers and recovers missed Projection admissions from lake
state.

## Delivery contract

Schedule, dataset, sync, pipeline, and workflow routes consume runtime events. Their delivery
guarantee follows the event source and route-specific retry policy.

Each routed primitive uses its Core-owned dispatcher to persist the execution and run before queue
publication. Projection admission has two trigger paths:

```text
dataset.version.committed -> ProjectionRunDispatcher -> durable execution + run -> queue
startup + periodic lake reconciliation -----------^
```

Both paths call the same `ProjectionRunDispatcher`, which derives the same deterministic run ID.
The queue carries only that `runId`; the durable run owns the pinned dataset version and Projection
identity.

## Usage (co-hosted in `sixb dev`)

When `cohostWorkers` is enabled, `sixb dev` automatically compiles routes from registered syncs,
pipelines, and projections, starts the orchestrator, co-hosts available workers, and starts the
scheduler. No manual wiring is needed.

## Standalone deployment

In production the orchestrator runs as its own process via `sixb orchestrator` (the event-to-queue
dispatcher role) pointed at shared durable providers. In local development it is co-hosted within
`sixb dev` alongside the scheduler and workers, so no manual wiring is needed there.

## Limitations (V1)

- Projection reconciliation repairs a missed dataset event by admitting the latest data-bearing
  version. It is not an event replay log and does not materialize every intermediate version.
- Publication recovery between durable run admission and queue publication remains a shared
  follow-up for every primitive dispatcher; reconciliation does not yet repair that crash window.
- **No dynamic routes**: adding syncs, pipelines, or projections after startup requires a restart.
- **Limited event types**: schedule, sync completion, pipeline completion, and dataset commit events
  are routed. `rule.triggered` and workflow events will be added later.
