import type { DomainEvent, StoredDomainEvent } from "@pario/core"
import { Worker } from "@pario/core"
import { OrchestratorError } from "./errors"
import { routeKeyForEvent } from "./route-key"
import type { OrchestratorJob, OrchestratorRoutes, OrchestratorRuntimeOptions } from "./types"

/**
 * Derives the minimal set of event types the orchestrator needs to subscribe to,
 * based on the structured route metadata compiled at startup.
 */
function deriveSubscribedTypes(routes: OrchestratorRoutes): DomainEvent["type"][] {
  return [...new Set([...routes.values()].map((route) => route.eventType))]
}

export class OrchestratorWorker extends Worker {
  private readonly options: OrchestratorRuntimeOptions

  constructor(options: OrchestratorRuntimeOptions) {
    if (!options.projectId) {
      throw new OrchestratorError("projectId is required.")
    }
    super()
    this.options = options
  }

  protected async run(signal: AbortSignal): Promise<void> {
    const options = this.options
    let pending: Promise<void> = Promise.resolve()

    const subscribedTypes = deriveSubscribedTypes(options.routes)

    const unsubscribe = await options.events.subscribe({ types: subscribedTypes }, (events) => {
      if (signal.aborted) return
      pending = pending
        .then(() => dispatch(options, events))
        .catch((error) => {
          // Never crash the subscribe loop — log and keep consuming.
          console.error("[ParioOrchestrator] Dispatch failed:", error)
        })
    })

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener("abort", () => resolve(), { once: true })
    })

    unsubscribe()
    await pending
  }
}

async function dispatch(
  options: OrchestratorRuntimeOptions,
  events: readonly StoredDomainEvent[]
): Promise<void> {
  for (const event of events) {
    const key = routeKeyForEvent(event)
    if (!key) continue
    const route = options.routes.get(key)
    if (!route) continue
    for (const item of route.jobs) {
      try {
        await enqueueJob(options, event, item)
      } catch (error) {
        // Best-effort: an error on one fan-out sibling must not drop the rest.
        console.error(
          `[ParioOrchestrator] Enqueue failed (queue=${item.queue}, eventId=${event.id}):`,
          error
        )
      }
    }
  }
}

async function enqueueJob(
  options: OrchestratorRuntimeOptions,
  sourceEvent: StoredDomainEvent,
  item: OrchestratorJob
): Promise<void> {
  const metadata = buildMetadata(sourceEvent)
  switch (item.queue) {
    case "syncRuns":
      await options.queues.syncRuns.enqueue({
        projectId: options.projectId,
        jobs: [{ ...item.job, metadata }],
      })
      return
    case "pipelines":
      await options.queues.pipelines.enqueue({
        projectId: options.projectId,
        jobs: [{ ...item.job, metadata }],
      })
      return
    case "projections":
      if (sourceEvent.type !== "dataset.version.committed") {
        throw new OrchestratorError(
          `Projection jobs can only be dispatched from dataset.version.committed events, got '${sourceEvent.type}'.`
        )
      }
      if (item.job.payload.datasetId !== sourceEvent.payload.datasetId) {
        throw new OrchestratorError(
          `Projection route for dataset '${item.job.payload.datasetId}' received dataset '${sourceEvent.payload.datasetId}'.`
        )
      }
      await options.queues.projections.enqueue({
        projectId: options.projectId,
        jobs: [
          {
            type: item.job.type,
            payload: {
              ...item.job.payload,
              versionId: sourceEvent.payload.versionId,
            },
            metadata,
          },
        ],
      })
      return
    case "workflows":
      await options.queues.workflows.enqueue({
        projectId: options.projectId,
        jobs: [{ ...item.job, metadata }],
      })
      return
  }
}

function buildMetadata(event: StoredDomainEvent): Record<string, string> {
  switch (event.type) {
    case "schedule.triggered":
      return {
        sourceEventId: event.id,
        sourceEventType: event.type,
        scheduleId: event.payload.scheduleId,
        occurrenceKey: event.payload.occurrenceKey,
      }
    case "sync.run.finished":
      return {
        sourceEventId: event.id,
        sourceEventType: event.type,
        syncId: event.payload.syncId,
        runId: event.payload.runId,
        status: event.payload.status,
      }
    case "pipeline.run.finished":
      return {
        sourceEventId: event.id,
        sourceEventType: event.type,
        pipelineId: event.payload.pipelineId,
        runId: event.payload.runId,
        status: event.payload.status,
      }
    case "dataset.version.committed": {
      const metadata: Record<string, string> = {
        sourceEventId: event.id,
        sourceEventType: event.type,
        datasetId: event.payload.datasetId,
        versionId: event.payload.versionId,
        producerKind: event.payload.producer.kind,
      }
      if (event.payload.producer.id !== undefined) {
        metadata.producerId = event.payload.producer.id
      }
      if (event.payload.producer.runId !== undefined) {
        metadata.producerRunId = event.payload.producer.runId
      }
      return metadata
    }
    default:
      return {}
  }
}
