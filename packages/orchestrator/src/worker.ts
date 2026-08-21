import type { DomainEvent } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { StoredDomainEvent } from "@sixb/core/internal/events"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import { evaluateEventSchedule } from "@sixb/core/internal/schedules"
import { Worker } from "@sixb/core/internal/workers"
import { runProjectionDispatchReconciler } from "./projection-dispatch-reconciler"
import { buildProjectionJob } from "./projection-job"
import { routeKeysForEvent } from "./route-key"
import type {
  OrchestratorDispatchers,
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
  private readonly projectionDescriptors: readonly ProjectionDispatchDescriptor[]

  constructor(options: OrchestratorRuntimeOptions) {
    if (!options.projectId) {
      throw createSixbError("internal.unexpected", "[SixbOrchestrator] projectId is required.")
    }
    super()
    this.options = options
    this.projectionDescriptors = projectionDescriptors(options.projectId, options.routes)
    if (this.projectionDescriptors.length > 0 && !options.projectionDispatch) {
      throw createSixbError(
        "internal.unexpected",
        "[SixbOrchestrator] Projection routes require lake and projection-run storage for durable dispatch.",
        {
          details: {
            projectId: options.projectId,
            projectionIds: this.projectionDescriptors.map((descriptor) => descriptor.projectionId),
          },
        }
      )
    }
    for (const key of ["syncs", "pipelines", "workflows"] as const) {
      if (hasDispatcherRoutes(options.routes, key)) requireDispatcher(options, key)
    }
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
    if (this.projectionDescriptors.length > 0) {
      const dispatch = this.options.projectionDispatch!
      consumers.push(
        runProjectionDispatchReconciler(
          {
            projectId: this.options.projectId,
            queue: this.options.queues.projections,
            descriptors: this.projectionDescriptors,
            ...dispatch,
          },
          signal
        )
      )
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
    case "syncRuns": {
      if (sourceEvent.type !== "schedule.triggered") {
        throw createSixbError(
          "internal.unexpected",
          `[SixbOrchestrator] Direct Sync route received unsupported event '${sourceEvent.type}'.`,
          { details: { projectId: options.projectId, sourceEventType: sourceEvent.type } }
        )
      }
      const scheduleId = sourceEvent.payload.scheduleId
      await requireDispatcher(options, "syncs").dispatch({
        syncId: item.job.payload.syncId,
        runId: scheduleConsumerRunId("sync", item.job.payload.syncId, scheduleId, sourceEvent.id),
        source: { type: "schedule", eventId: sourceEvent.id },
        correlationId: correlationIdForEvent(sourceEvent),
        metadata,
      })
      return
    }
    case "pipelines": {
      if (sourceEvent.type !== "schedule.triggered") {
        throw createSixbError(
          "internal.unexpected",
          `[SixbOrchestrator] Direct Pipeline route received unsupported event '${sourceEvent.type}'.`,
          { details: { projectId: options.projectId, sourceEventType: sourceEvent.type } }
        )
      }
      const scheduleId = sourceEvent.payload.scheduleId
      await requireDispatcher(options, "pipelines").dispatch({
        pipelineId: item.job.payload.pipelineId,
        runId: scheduleConsumerRunId(
          "pipeline",
          item.job.payload.pipelineId,
          scheduleId,
          sourceEvent.id
        ),
        source: { type: "schedule", eventId: sourceEvent.id },
        correlationId: correlationIdForEvent(sourceEvent),
        metadata,
      })
      return
    }
    case "projections": {
      if (sourceEvent.type !== "dataset.version.committed") {
        throw createSixbError(
          "internal.unexpected",
          `[SixbOrchestrator] Projection jobs can only be dispatched from dataset.version.committed events, got '${sourceEvent.type}'.`,
          {
            details: {
              projectId: options.projectId,
              projectionId: item.job.payload.projectionId,
              sourceEventId: sourceEvent.id,
              sourceEventType: sourceEvent.type,
            },
          }
        )
      }
      if (item.job.payload.datasetId !== sourceEvent.payload.datasetId) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbOrchestrator] Projection route for dataset '${item.job.payload.datasetId}' received dataset '${sourceEvent.payload.datasetId}'.`,
          {
            details: {
              projectId: options.projectId,
              projectionId: item.job.payload.projectionId,
              sourceEventId: sourceEvent.id,
              sourceEventType: sourceEvent.type,
              expectedDatasetId: item.job.payload.datasetId,
              actualDatasetId: sourceEvent.payload.datasetId,
            },
          }
        )
      }
      const job = buildProjectionJob({
        projectId: options.projectId,
        descriptor: item.job.payload,
        datasetVersion: {
          datasetId: sourceEvent.payload.datasetId,
          versionId: sourceEvent.payload.versionId,
          createdAt: sourceEvent.payload.createdAt,
        },
        metadata,
      })
      await options.queues.projections.enqueue({
        projectId: options.projectId,
        jobs: [job],
      })
      return
    }
    case "workflows": {
      if (sourceEvent.type !== "schedule.triggered") {
        throw createSixbError(
          "internal.unexpected",
          `[SixbOrchestrator] Direct workflow route received unsupported event '${sourceEvent.type}'.`,
          {
            details: {
              projectId: options.projectId,
              workflowId: item.job.payload.workflowId,
              sourceEventId: sourceEvent.id,
              sourceEventType: sourceEvent.type,
            },
          }
        )
      }
      const scheduleId = sourceEvent.payload.scheduleId
      await requireDispatcher(options, "workflows").dispatch({
        workflowId: item.job.payload.workflowId,
        runId: scheduleConsumerRunId(
          "workflow",
          item.job.payload.workflowId,
          scheduleId,
          sourceEvent.id
        ),
        input: item.job.payload.input,
        scheduleId,
        source: { type: "schedule", eventId: sourceEvent.id },
        correlationId: correlationIdForEvent(sourceEvent),
        metadata,
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
      await requireDispatcher(options, "syncs").dispatch({
        syncId: target.syncId,
        runId: scheduleConsumerRunId("sync", target.syncId, scheduleId, sourceEvent.id),
        source: { type: "event", eventId: sourceEvent.id },
        correlationId: correlationIdForEvent(sourceEvent),
        metadata,
      })
      return
    case "pipelines":
      await requireDispatcher(options, "pipelines").dispatch({
        pipelineId: target.pipelineId,
        runId: scheduleConsumerRunId("pipeline", target.pipelineId, scheduleId, sourceEvent.id),
        source: { type: "event", eventId: sourceEvent.id },
        correlationId: correlationIdForEvent(sourceEvent),
        metadata,
      })
      return
    case "workflows": {
      const input = target.mapper ? target.mapper({ event } as never) : {}
      if (!isRecord(input)) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbOrchestrator] Workflow '${target.workflowId}' schedule mapper must return an input object.`,
          {
            details: {
              projectId: options.projectId,
              workflowId: target.workflowId,
              scheduleId,
              sourceEventId: sourceEvent.id,
              sourceEventType: sourceEvent.type,
            },
          }
        )
      }
      await requireDispatcher(options, "workflows").dispatch({
        workflowId: target.workflowId,
        runId: scheduleConsumerRunId("workflow", target.workflowId, scheduleId, sourceEvent.id),
        input,
        scheduleId,
        source: { type: "event", eventId: sourceEvent.id },
        correlationId: correlationIdForEvent(sourceEvent),
        metadata,
      })
      return
    }
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
        datasetVersionCreatedAt: event.payload.createdAt,
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

function correlationIdForEvent(event: StoredDomainEvent): string {
  if (
    "correlationId" in event &&
    typeof event.correlationId === "string" &&
    event.correlationId.trim()
  ) {
    return event.correlationId
  }
  return event.id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function projectionDescriptors(
  projectId: string,
  routes: OrchestratorRoutes
): readonly ProjectionDispatchDescriptor[] {
  const descriptors = new Map<string, ProjectionDispatchDescriptor>()
  for (const route of routes.values()) {
    for (const item of route.jobs) {
      if (item.queue !== "projections") continue
      const existing = descriptors.get(item.job.payload.projectionId)
      if (existing && !projectionDescriptorsEqual(existing, item.job.payload)) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbOrchestrator] Projection '${item.job.payload.projectionId}' has conflicting dispatch routes.`,
          { details: { projectId, projectionId: item.job.payload.projectionId } }
        )
      }
      descriptors.set(item.job.payload.projectionId, item.job.payload)
    }
  }
  return [...descriptors.values()].sort((left, right) =>
    left.projectionId.localeCompare(right.projectionId)
  )
}

function hasDispatcherRoutes(
  routes: OrchestratorRoutes,
  key: keyof OrchestratorDispatchers
): boolean {
  const queue = key === "syncs" ? "syncRuns" : key
  for (const route of routes.values()) {
    if (route.jobs.some((item) => item.queue === queue)) return true
    if (
      route.eventSchedules?.some((binding) =>
        binding.targets.some((target) => target.queue === queue)
      )
    ) {
      return true
    }
  }
  return false
}

function requireDispatcher<TKey extends keyof OrchestratorDispatchers>(
  options: Pick<OrchestratorRuntimeOptions, "projectId" | "dispatchers">,
  key: TKey
): NonNullable<OrchestratorDispatchers[TKey]> {
  const dispatcher = options.dispatchers[key]
  if (!dispatcher) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbOrchestrator] Routes require the '${key}' dispatcher.`,
      { details: { projectId: options.projectId, dispatcher: key } }
    )
  }
  return dispatcher
}

function projectionDescriptorsEqual(
  left: ProjectionDispatchDescriptor,
  right: ProjectionDispatchDescriptor
): boolean {
  return (
    left.projectionId === right.projectionId &&
    left.projectionKind === right.projectionKind &&
    left.protocol === right.protocol &&
    left.datasetId === right.datasetId &&
    left.ontologyRevision === right.ontologyRevision &&
    left.projectionRevision === right.projectionRevision &&
    left.ownershipHash === right.ownershipHash
  )
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
