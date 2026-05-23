# @sixb/orchestrator

Bridges runtime events to `SixbQueues` job lanes.
V1 routes runtime facts into `syncRuns`, `pipelines`, and `projections` queue lanes.

## Delivery contract

**At-most-once per occurrence, at-least-once across cadence.**

The scheduler uses fire-and-forget event emission (`void events.append(...)`).
If the append is rejected asynchronously, that specific occurrence is lost.
The next cadence tick will produce a new event normally.
This gap is a known upstream limitation to be addressed in a follow-up on the scheduler.

## Usage (co-hosted in `sixb dev`)

When `cohostWorkers` is enabled, `sixb dev` automatically compiles routes from registered syncs,
pipelines, and projections, starts the orchestrator, co-hosts available workers, and starts the scheduler. No manual wiring is needed.

For testing or custom setups:

```ts
import { compileRoutes, OrchestratorWorker } from "@sixb/orchestrator"

const routes = compileRoutes({
  syncs: sixb.getSyncDefinitions(),
  pipelines: sixb.getPipelineDefinitions(),
  projections: [...sixb.getObjectProjections(), ...sixb.getLinkProjections()],
})

const worker = new OrchestratorWorker({
  projectId: sixb.id,
  events: sixb.events,
  queues: sixb.queues,
  routes,
})

await worker.start()
// ... worker is now routing subscribed events into queue jobs
await worker.stop()
```

## Standalone deployment

Standalone deployment (running the orchestrator as a separate process) is **not supported in V1**.
The orchestrator is designed to be co-hosted within `sixb dev` alongside the scheduler and workers.

## Limitations (V1)

- **No deduplication**: if an event is delivered twice, two jobs are enqueued.
- **No catch-up**: events emitted before `start()` are never processed (live-only).
- **No dynamic routes**: adding syncs, pipelines, or projections after startup requires a restart.
- **Limited event types**: schedule, sync completion, pipeline completion, and dataset commit events are routed. `rule.triggered` and workflow events will be added later.
