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

const TRIGGER_RETRY_INITIAL_DELAY_MS = 250
const TRIGGER_RETRY_MAX_DELAY_MS = 10_000

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
    const { jobTypes, triggerTypes } = deriveSubscribedTypes(options.routes)
    const consumers: Promise<void>[] = []

    if (jobTypes.length > 0) {
      consumers.push(consumeLiveJobs(options, jobTypes, signal))
    }
    for (const eventType of triggerTypes) {
      consumers.push(consumeRetainedTriggers(options, eventType, signal))
    }

    await Promise.all(consumers)
  }
}

function deriveSubscribedTypes(routes: OrchestratorRoutes): {
  readonly jobTypes: readonly DomainEvent["type"][]
  readonly triggerTypes: readonly DomainEvent["type"][]
} {
  const jobTypes = new Set<DomainEvent["type"]>()
  const triggerTypes = new Set<DomainEvent["type"]>()

  for (const route of routes.values()) {
    if (route.jobs.length > 0) {
      jobTypes.add(route.eventType)
    }
    if ((route.workflowTriggers?.length ?? 0) > 0) {
      triggerTypes.add(route.eventType)
    }
  }

  return { jobTypes: [...jobTypes], triggerTypes: [...triggerTypes] }
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
      .then(() => dispatchJobs(options, events))
      .catch((error) => {
        console.error("[SixbOrchestrator] Dispatch failed:", error)
      })
  })

  await waitForAbort(signal)
  unsubscribe()
  await pending
}

async function consumeRetainedTriggers(
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
            await dispatchTriggers(options, events)
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
        `[SixbOrchestrator] Trigger subscription failed for '${eventType}'; retrying:`,
        error
      )
      await sleep(triggerRetryDelay(retryAttempt), signal)
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
    if (outcome.type === "aborted" || signal.aborted) {
      return
    }

    console.error(
      `[SixbOrchestrator] Trigger dispatch failed for '${eventType}'; replaying retained events:`,
      outcome.error
    )
    await sleep(triggerRetryDelay(retryAttempt), signal)
    retryAttempt += 1
  }
}

async function dispatchJobs(
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
    }
  }
}

async function dispatchTriggers(
  options: OrchestratorRuntimeOptions,
  events: readonly StoredDomainEvent[]
): Promise<void> {
  for (const event of events) {
    for (const key of routeKeysForEvent(event)) {
      const bindings = options.routes.get(key)?.workflowTriggers ?? []
      const results = await Promise.allSettled(
        bindings.map((binding) => requestTriggeredWorkflow(options, event, binding))
      )
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason)
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, `Trigger dispatch failed for event '${event.id}'.`)
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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }

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

function triggerRetryDelay(attempt: number): number {
  return Math.min(TRIGGER_RETRY_INITIAL_DELAY_MS * 2 ** attempt, TRIGGER_RETRY_MAX_DELAY_MS)
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
