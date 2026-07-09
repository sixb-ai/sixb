import type {
  DomainEvent,
  DomainTriggerDefinition,
  StoredDomainEvent,
  WorkflowDefinition,
} from "@sixb/core"
import { evaluateTrigger, SYSTEM_PRINCIPAL, Worker } from "@sixb/core"
import { OrchestratorError } from "./errors"
import { routeKeysForEvent } from "./route-key"
import type {
  OrchestratorJob,
  OrchestratorRoutes,
  OrchestratorRuntimeOptions,
  OrchestratorWorkflowTriggerBinding,
} from "./types"

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
          console.error("[SixbOrchestrator] Dispatch failed:", error)
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
    for (const key of routeKeysForEvent(event)) {
      const route = options.routes.get(key)
      if (!route) continue
      for (const item of route.jobs) {
        try {
          await enqueueJob(options, event, item)
        } catch (error) {
          // Best-effort: an error on one fan-out sibling must not drop the rest.
          console.error(
            `[SixbOrchestrator] Enqueue failed (queue=${item.queue}, eventId=${event.id}):`,
            error
          )
        }
      }
      for (const binding of route.workflowTriggers ?? []) {
        try {
          await requestTriggeredWorkflow(options, event, binding)
        } catch (error) {
          console.error(
            `[SixbOrchestrator] Trigger workflow request failed (workflowId=${binding.workflowId}, triggerId=${binding.triggerId}, eventId=${event.id}):`,
            error
          )
        }
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

async function requestTriggeredWorkflow(
  options: OrchestratorRuntimeOptions,
  sourceEvent: StoredDomainEvent,
  binding: OrchestratorWorkflowTriggerBinding
): Promise<void> {
  const workflow = findWorkflow(options, binding.workflowId)
  if (!workflow) {
    throw new OrchestratorError(`Unknown workflow '${binding.workflowId}'.`)
  }

  const workflowTrigger = workflow.triggers.find(
    (trigger) => trigger.type === "trigger" && trigger.triggerId === binding.triggerId
  )
  if (!workflowTrigger || workflowTrigger.type !== "trigger") {
    throw new OrchestratorError(
      `Workflow '${binding.workflowId}' is not bound to trigger '${binding.triggerId}'.`
    )
  }

  const trigger = findTrigger(options, binding.triggerId)
  if (!trigger) {
    throw new OrchestratorError(`Unknown trigger '${binding.triggerId}'.`)
  }

  const match = evaluateTrigger(trigger, sourceEvent)
  if (!match) {
    return
  }

  const input = workflowTrigger.mapper ? workflowTrigger.mapper(match.event as never) : {}
  if (!isRecord(input)) {
    throw new OrchestratorError(
      `Workflow '${workflow.id}' trigger mapper must return an input object.`
    )
  }

  await options.queues.workflows.enqueue({
    projectId: options.projectId,
    jobs: [
      {
        type: "workflow.run.requested",
        payload: {
          workflowId: workflow.id,
          runId: workflowTriggerRunId(workflow.id, trigger.id, sourceEvent.id),
          input,
          source: {
            type: "trigger",
            triggerId: trigger.id,
            eventId: sourceEvent.id,
            principal: SYSTEM_PRINCIPAL,
          },
        },
        metadata: buildMetadata(sourceEvent),
      },
    ],
  })
}

function findWorkflow(
  options: OrchestratorRuntimeOptions,
  workflowId: string
): WorkflowDefinition | null {
  return (options.workflows ?? []).find((workflow) => workflow.id === workflowId) ?? null
}

function findTrigger(
  options: OrchestratorRuntimeOptions,
  triggerId: string
): DomainTriggerDefinition | null {
  return (options.triggers ?? []).find((trigger) => trigger.id === triggerId) ?? null
}

function workflowTriggerRunId(workflowId: string, triggerId: string, eventId: string): string {
  return `workflow:${workflowId}:trigger:${triggerId}:event:${eventId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
