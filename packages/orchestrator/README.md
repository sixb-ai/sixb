# @sixb/orchestrator

Bridges runtime events to queue lanes and durably reconciles projection dispatch from lake state.

## Delivery contract

Schedule, sync, pipeline, and workflow routes consume runtime events. Their delivery guarantee follows
the event source and route-specific retry policy.

Workflow routes use a Core-owned dispatch port that persists the workflow execution and run before publishing the queue job. Projection dispatch has two paths:

```text
dataset.version.committed -> immediate deterministic job
startup + periodic lake reconciliation -> repair a missing deterministic job
```

Both paths compute the same job ID. A durable projection run prevents redispatch after queue
completion; queue-level IDs deduplicate concurrent dispatches.

## Usage (co-hosted in `sixb dev`)

When `cohostWorkers` is enabled, `sixb dev` automatically compiles routes from registered syncs,
pipelines, and projections, starts the orchestrator, co-hosts available workers, and starts the scheduler. No manual wiring is needed.

Custom framework hosts must provide the narrow durable ports used by their compiled routes:

```ts
import { getProjectionDispatchDescriptors } from "@sixb/core/internal/projections"
import { WorkflowRunDispatcher } from "@sixb/core/internal/workflows"
import { compileRoutesWithDiagnostics, OrchestratorWorker } from "@sixb/orchestrator"

const projectionDispatchDescriptors = getProjectionDispatchDescriptors(sixb)
const { routes } = compileRoutesWithDiagnostics({
  schedules: sixb.definitions.schedules.list(),
  syncs: sixb.definitions.syncs.list(),
  pipelines: sixb.definitions.pipelines.list(),
  projections: projectionDispatchDescriptors,
  workflows: sixb.definitions.workflows.list(),
})

const worker = new OrchestratorWorker({
  projectId: sixb.id,
  events: sixb.events,
  queues: sixb.queues,
  routes,
  dispatchers: {
    workflows: new WorkflowRunDispatcher(sixb),
  },
  projectionDispatch: {
    lakeStorage: sixb.lakeStorage,
    projectionRuns: sixb.storage.projectionRuns,
  },
})

await worker.start()
// ... worker is now routing subscribed events into queue jobs
await worker.stop()
```

## Standalone deployment

In production the orchestrator runs as its own process via `sixb orchestrator` (the event-to-queue
dispatcher role) pointed at shared durable providers. In local development it is co-hosted within
`sixb dev` alongside the scheduler and workers, so no manual wiring is needed there.

## Limitations (V1)

- Direct non-projection jobs retain their route-specific event semantics.
- Projection reconciliation converges to the latest data-bearing dataset version; it is not an
  event replay log.
- **No dynamic routes**: adding syncs, pipelines, or projections after startup requires a restart.
- **Limited event types**: schedule, sync completion, pipeline completion, and dataset commit events are routed. `rule.triggered` and workflow events will be added later.
