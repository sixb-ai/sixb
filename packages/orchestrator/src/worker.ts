import type { DomainEvent } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { StoredDomainEvent } from "@sixb/core/internal/events"
import { evaluateEventSchedule } from "@sixb/core/internal/schedules"
import { Worker } from "@sixb/core/internal/workers"
import { type DispatchJob, JobDispatch } from "./job-dispatch"
import { routeKeysForEvent } from "./route-key"
import type {
  OrchestratorDispatchers,
  OrchestratorEventScheduleBinding,
  OrchestratorEventScheduleTarget,
  OrchestratorJob,
  OrchestratorRoutes,
  OrchestratorRuntimeOptions,
} from "./types"

const SUBSCRIBE_RETRY_INITIAL_DELAY_MS = 250
const SUBSCRIBE_RETRY_MAX_DELAY_MS = 10_000

export class OrchestratorWorker extends Worker {
  private readonly options: OrchestratorRuntimeOptions

  constructor(options: OrchestratorRuntimeOptions) {
    if (!options.projectId) {
      throw createSixbError("internal.unexpected", "[SixbOrchestrator] projectId is required.")
    }
    super()
    this.options = options
    for (const key of ["syncs", "pipelines", "projections", "workflows"] as const) {
      if (hasDispatcherRoutes(options.routes, key)) requireDispatcher(options, key)
    }
  }

  /** One subscription per event type, so a job that keeps failing holds its own type at most. */
  protected async run(signal: AbortSignal): Promise<void> {
    const { directJobTypes, eventScheduleTypes } = deriveSubscribedTypes(this.options.routes)
    const consumers: Promise<void>[] = []

    for (const eventType of directJobTypes) {
      consumers.push(consumeLiveJobs(this.options, eventType, signal))
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
  eventType: DomainEvent["type"],
  signal: AbortSignal
): Promise<void> {
  await consumeBatches(
    options,
    { types: [eventType] },
    (events) => directJobs(options, events),
    signal
  )
}

async function consumeRetainedEventSchedules(
  options: OrchestratorRuntimeOptions,
  eventType: DomainEvent["type"],
  signal: AbortSignal
): Promise<void> {
  await consumeBatches(
    options,
    { types: [eventType], from: "earliest" },
    (events) => eventScheduleJobs(options, events),
    signal
  )
}

/**
 * Keep only the current batch in flight. The provider owns the unread backlog. A batch ends once
 * each of its jobs was dispatched or left to retry on its own.
 */
async function consumeBatches(
  options: OrchestratorRuntimeOptions,
  input: Parameters<OrchestratorRuntimeOptions["events"]["subscribe"]>[0],
  jobsOf: (events: readonly StoredDomainEvent[]) => readonly DispatchJob[],
  signal: AbortSignal
): Promise<void> {
  const dispatch = new JobDispatch({
    projectId: options.projectId,
    reporter: options.reporter,
    signal,
  })

  let attempt = 0
  while (!signal.aborted) {
    let pending: Promise<void> = Promise.resolve()
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = await options.events.subscribe(input, (events) => {
        pending = dispatch.all(jobsOf(events))
        return pending
      })
    } catch (error) {
      if (signal.aborted) return
      console.error("[SixbOrchestrator] Subscription failed; retrying:", error)
      await sleep(subscribeRetryDelay(attempt++), signal)
      continue
    }
    await waitForAbort(signal)
    unsubscribe()
    await pending
    await dispatch.drain()
    return
  }
}

function directJobs(
  options: OrchestratorRuntimeOptions,
  events: readonly StoredDomainEvent[]
): readonly DispatchJob[] {
  return events.flatMap((event) =>
    routeKeysForEvent(event).flatMap((key) =>
      (options.routes.get(key)?.jobs ?? []).map((item) => ({
        event,
        target: directJobTarget(item),
        dispatch: () => enqueueDirectJob(options, event, item),
      }))
    )
  )
}

function eventScheduleJobs(
  options: OrchestratorRuntimeOptions,
  events: readonly StoredDomainEvent[]
): readonly DispatchJob[] {
  return events.flatMap((event) =>
    routeKeysForEvent(event).flatMap((key) =>
      (options.routes.get(key)?.eventSchedules ?? []).flatMap((binding) =>
        binding.targets.map((target) => ({
          event,
          target: eventScheduleTarget(target),
          dispatch: () => dispatchEventSchedule(options, event, binding, target),
        }))
      )
    )
  )
}

function directJobTarget(item: OrchestratorJob): string {
  switch (item.queue) {
    case "syncRuns":
      return `sync:${item.job.payload.syncId}`
    case "pipelines":
      return `pipeline:${item.job.payload.pipelineId}`
    case "projections":
      return `projection:${item.job.payload.projectionId}`
    case "workflows":
      return `workflow:${item.job.payload.workflowId}`
  }
}

function eventScheduleTarget(target: OrchestratorEventScheduleTarget): string {
  switch (target.queue) {
    case "syncRuns":
      return `sync:${target.syncId}`
    case "pipelines":
      return `pipeline:${target.pipelineId}`
    case "workflows":
      return `workflow:${target.workflowId}`
  }
}

async function dispatchEventSchedule(
  options: OrchestratorRuntimeOptions,
  sourceEvent: StoredDomainEvent,
  binding: OrchestratorEventScheduleBinding,
  target: OrchestratorEventScheduleTarget
): Promise<void> {
  const match = evaluateEventSchedule(binding.schedule, sourceEvent)
  if (!match) return

  await enqueueEventScheduleTarget(options, sourceEvent, binding.schedule.id, match.event, target)
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
      await requireDispatcher(options, "projections").dispatch({
        projectionId: item.job.payload.projectionId,
        datasetVersion: {
          datasetId: sourceEvent.payload.datasetId,
          versionId: sourceEvent.payload.versionId,
          createdAt: sourceEvent.payload.createdAt,
        },
        metadata,
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

export function requireDispatcher<TKey extends keyof OrchestratorDispatchers>(
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

function subscribeRetryDelay(attempt: number): number {
  return Math.min(SUBSCRIBE_RETRY_INITIAL_DELAY_MS * 2 ** attempt, SUBSCRIBE_RETRY_MAX_DELAY_MS)
}
