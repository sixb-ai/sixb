import type { DomainEvent } from "@sixb/core"
import { SYSTEM_PRINCIPAL } from "@sixb/core"
import type { StoredDomainEvent } from "@sixb/core/internal/events"
import { evaluateEventSchedule } from "@sixb/core/internal/schedules"
import { Worker } from "@sixb/core/internal/workers"
import { OrchestratorError } from "./errors"
import { routeKeysForEvent } from "./route-key"
import type {
  OrchestratorEventScheduleBinding,
  OrchestratorEventScheduleTarget,
  OrchestratorJob,
  OrchestratorRoutes,
  OrchestratorRuntimeOptions,
} from "./types"

const EVENT_SCHEDULE_RETRY_INITIAL_DELAY_MS = 250
const EVENT_SCHEDULE_RETRY_MAX_DELAY_MS = 10_000

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
    const { directJobTypes, eventScheduleTypes } = deriveSubscribedTypes(this.options.routes)
    const consumers: Promise<void>[] = []

    if (directJobTypes.length > 0) {
      consumers.push(consumeLiveJobs(this.options, directJobTypes, signal))
    }
    for (const eventType of eventScheduleTypes) {
      consumers.push(consumeRetainedEventSchedules(this.options, eventType, signal))
    }

    await Promise.all(consumers)
  }
}

function deriveSubscribedTypes(routes: OrchestratorRoutes): {
  readonly directJobTypes: readonly DomainEvent["type"][]
  readonly eventScheduleTypes: readonly DomainEvent["type"][]
} {
  const directJobTypes = new Set<DomainEvent["type"]>()
  const eventScheduleTypes = new Set<DomainEvent["type"]>()

  for (const route of routes.values()) {
    if (route.jobs.length > 0) directJobTypes.add(route.eventType)
    if ((route.eventSchedules?.length ?? 0) > 0) eventScheduleTypes.add(route.eventType)
  }

  return {
    directJobTypes: [...directJobTypes],
    eventScheduleTypes: [...eventScheduleTypes],
  }
}

async function consumeLiveJobs(
  options: OrchestratorRuntimeOptions,
  types: readonly DomainEvent["type"][],
  signal: AbortSignal
): Promise<void> {
  let pending: Promise<void> = Promise.resolve()
  const unsubscribe = await options.events.subscribe({ types }, (events) => {
    if (signal.aborted) return
    pending = pending
      .then(() => dispatchDirectJobs(options, events))
      .catch((error) => console.error("[SixbOrchestrator] Dispatch failed:", error))
  })

  await waitForAbort(signal)
  unsubscribe()
  await pending
}

async function consumeRetainedEventSchedules(
  options: OrchestratorRuntimeOptions,
  eventType: DomainEvent["type"],
  signal: AbortSignal
): Promise<void> {
  let retryAttempt = 0
  while (!signal.aborted) {
    const failure = deferred<unknown>()
    const aborted = deferred<void>()
    const onAbort = () => aborted.resolve()
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) aborted.resolve()
    let failed = false
    let pending: Promise<void> = Promise.resolve()
    let unsubscribe: (() => void) | undefined

    try {
      unsubscribe = await options.events.subscribe(
        { types: [eventType], from: "earliest" },
        (events) => {
          if (signal.aborted || failed) return
          pending = pending.then(async () => {
            await dispatchEventSchedules(options, events)
            retryAttempt = 0
          })
          pending.catch((error) => {
            if (failed) return
            failed = true
            failure.resolve(error)
          })
        }
      )
    } catch (error) {
      signal.removeEventListener("abort", onAbort)
      if (signal.aborted) return
      console.error(
        `[SixbOrchestrator] Event schedule subscription failed for '${eventType}'; retrying:`,
        error
      )
      await sleep(eventScheduleRetryDelay(retryAttempt), signal)
      retryAttempt += 1
      continue
    }

    const outcome = await Promise.race([
      aborted.promise.then(() => ({ type: "aborted" as const })),
      failure.promise.then((error) => ({ type: "failed" as const, error })),
    ])

    signal.removeEventListener("abort", onAbort)
    unsubscribe()
    await pending.catch(() => {})
    if (outcome.type === "aborted" || signal.aborted) return

    console.error(
      `[SixbOrchestrator] Event schedule dispatch failed for '${eventType}'; replaying retained events:`,
      outcome.error
    )
    await sleep(eventScheduleRetryDelay(retryAttempt), signal)
    retryAttempt += 1
  }
}

async function dispatchDirectJobs(
  options: OrchestratorRuntimeOptions,
  events: readonly StoredDomainEvent[]
): Promise<void> {
  for (const event of events) {
    for (const key of routeKeysForEvent(event)) {
      const route = options.routes.get(key)
      if (!route) continue
      for (const item of route.jobs) {
        try {
          await enqueueDirectJob(options, event, item)
        } catch (error) {
          // One direct fan-out sibling must not prevent the others from being queued.
          console.error(
            `[SixbOrchestrator] Enqueue failed (queue=${item.queue}, eventId=${event.id}):`,
            error
          )
        }
      }
    }
  }
}

async function dispatchEventSchedules(
  options: OrchestratorRuntimeOptions,
  events: readonly StoredDomainEvent[]
): Promise<void> {
  for (const event of events) {
    for (const key of routeKeysForEvent(event)) {
      const bindings = options.routes.get(key)?.eventSchedules ?? []
      for (const binding of bindings) {
        await dispatchEventSchedule(options, event, binding)
      }
    }
  }
}

async function dispatchEventSchedule(
  options: OrchestratorRuntimeOptions,
  sourceEvent: StoredDomainEvent,
  binding: OrchestratorEventScheduleBinding
): Promise<void> {
  const match = evaluateEventSchedule(binding.schedule, sourceEvent)
  if (!match) return

  const results = await Promise.allSettled(
    binding.targets.map((target) =>
      enqueueEventScheduleTarget(options, sourceEvent, binding.schedule.id, match.event, target)
    )
  )
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason)

  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Schedule '${binding.schedule.id}' dispatch failed for event '${sourceEvent.id}'.`
    )
  }
}

async function enqueueDirectJob(
  options: OrchestratorRuntimeOptions,
  sourceEvent: StoredDomainEvent,
  item: OrchestratorJob
): Promise<void> {
  const metadata = buildMetadata(sourceEvent)
  switch (item.queue) {
    case "syncRuns":
      await options.queues.syncRuns.enqueue({
        projectId: options.projectId,
        jobs: [
          { ...item.job, payload: withSyncScheduleRunId(item.job.payload, sourceEvent), metadata },
        ],
      })
      return
    case "pipelines":
      await options.queues.pipelines.enqueue({
        projectId: options.projectId,
        jobs: [
          {
            ...item.job,
            payload: withPipelineScheduleRunId(item.job.payload, sourceEvent),
            metadata,
          },
        ],
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
            payload: { ...item.job.payload, versionId: sourceEvent.payload.versionId },
            metadata,
          },
        ],
      })
      return
    case "workflows": {
      const scheduleSource = workflowScheduleSource(sourceEvent)
      await options.queues.workflows.enqueue({
        projectId: options.projectId,
        jobs: [
          {
            ...item.job,
            payload: {
              ...item.job.payload,
              ...(scheduleSource
                ? {
                    runId: scheduleConsumerRunId(
                      "workflow",
                      item.job.payload.workflowId,
                      scheduleSource.scheduleId,
                      sourceEvent.id
                    ),
                    source: scheduleSource,
                  }
                : {}),
            },
            metadata,
          },
        ],
      })
      return
    }
  }
}

async function enqueueEventScheduleTarget(
  options: OrchestratorRuntimeOptions,
  sourceEvent: StoredDomainEvent,
  scheduleId: string,
  event: unknown,
  target: OrchestratorEventScheduleTarget
): Promise<void> {
  const metadata = { ...buildMetadata(sourceEvent), scheduleId }
  switch (target.queue) {
    case "syncRuns":
      await options.queues.syncRuns.enqueue({
        projectId: options.projectId,
        jobs: [
          {
            type: "sync.run.requested",
            payload: {
              syncId: target.syncId,
              runId: scheduleConsumerRunId("sync", target.syncId, scheduleId, sourceEvent.id),
            },
            metadata,
          },
        ],
      })
      return
    case "pipelines":
      await options.queues.pipelines.enqueue({
        projectId: options.projectId,
        jobs: [
          {
            type: "pipeline.run.requested",
            payload: {
              pipelineId: target.pipelineId,
              runId: scheduleConsumerRunId(
                "pipeline",
                target.pipelineId,
                scheduleId,
                sourceEvent.id
              ),
            },
            metadata,
          },
        ],
      })
      return
    case "workflows": {
      const input = target.mapper ? target.mapper({ event } as never) : {}
      if (!isRecord(input)) {
        throw new OrchestratorError(
          `Workflow '${target.workflowId}' schedule mapper must return an input object.`
        )
      }
      await options.queues.workflows.enqueue({
        projectId: options.projectId,
        jobs: [
          {
            type: "workflow.run.requested",
            payload: {
              workflowId: target.workflowId,
              runId: scheduleConsumerRunId(
                "workflow",
                target.workflowId,
                scheduleId,
                sourceEvent.id
              ),
              input,
              source: {
                type: "schedule",
                scheduleId,
                eventId: sourceEvent.id,
                principal: SYSTEM_PRINCIPAL,
              },
            },
            metadata,
          },
        ],
      })
      return
    }
  }
}

function withSyncScheduleRunId(
  payload: { readonly syncId: string; readonly runId?: string },
  sourceEvent: StoredDomainEvent
): { readonly syncId: string; readonly runId?: string } {
  if (payload.runId !== undefined || sourceEvent.type !== "schedule.triggered") return payload
  return {
    ...payload,
    runId: scheduleConsumerRunId(
      "sync",
      payload.syncId,
      sourceEvent.payload.scheduleId,
      sourceEvent.id
    ),
  }
}

function withPipelineScheduleRunId(
  payload: { readonly pipelineId: string; readonly runId?: string },
  sourceEvent: StoredDomainEvent
): { readonly pipelineId: string; readonly runId?: string } {
  if (payload.runId !== undefined || sourceEvent.type !== "schedule.triggered") return payload
  return {
    ...payload,
    runId: scheduleConsumerRunId(
      "pipeline",
      payload.pipelineId,
      sourceEvent.payload.scheduleId,
      sourceEvent.id
    ),
  }
}

function workflowScheduleSource(sourceEvent: StoredDomainEvent) {
  if (sourceEvent.type !== "schedule.triggered") return null
  return {
    type: "schedule" as const,
    scheduleId: sourceEvent.payload.scheduleId,
    eventId: sourceEvent.id,
    principal: SYSTEM_PRINCIPAL,
  }
}

function scheduleConsumerRunId(
  kind: "sync" | "pipeline" | "workflow",
  consumerId: string,
  scheduleId: string,
  eventId: string
): string {
  return `${kind}:${consumerId}:schedule:${scheduleId}:event:${eventId}`
}

function buildMetadata(event: StoredDomainEvent): Record<string, string> {
  const base = { sourceEventId: event.id, sourceEventType: event.type }
  switch (event.type) {
    case "schedule.triggered":
      return {
        ...base,
        scheduleId: event.payload.scheduleId,
        occurrenceKey: event.payload.occurrenceKey,
      }
    case "sync.run.finished":
      return {
        ...base,
        syncId: event.payload.syncId,
        runId: event.payload.runId,
        status: event.payload.status,
      }
    case "pipeline.run.finished":
      return {
        ...base,
        pipelineId: event.payload.pipelineId,
        runId: event.payload.runId,
        status: event.payload.status,
      }
    case "dataset.version.committed": {
      const metadata: Record<string, string> = {
        ...base,
        datasetId: event.payload.datasetId,
        versionId: event.payload.versionId,
        producerKind: event.payload.producer.kind,
      }
      if (event.payload.producer.id !== undefined) metadata.producerId = event.payload.producer.id
      if (event.payload.producer.runId !== undefined) {
        metadata.producerRunId = event.payload.producer.runId
      }
      return metadata
    }
    default:
      return base
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function eventScheduleRetryDelay(attempt: number): number {
  return Math.min(
    EVENT_SCHEDULE_RETRY_INITIAL_DELAY_MS * 2 ** attempt,
    EVENT_SCHEDULE_RETRY_MAX_DELAY_MS
  )
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
