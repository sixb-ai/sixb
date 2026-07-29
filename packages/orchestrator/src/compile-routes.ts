import type { DomainEvent, ScheduleDefinition, ScheduleReference } from "@sixb/core"
import { eventScheduleSubscribedEventTypes } from "@sixb/core/internal/schedules"
import { OrchestratorError } from "./errors"
import { eventScheduleRouteKeyForSelector } from "./route-key"
import type {
  CompileRoutesDiagnostic,
  CompileRoutesParams,
  CompileRoutesResult,
  OrchestratorEventScheduleBinding,
  OrchestratorEventScheduleTarget,
  OrchestratorJob,
  OrchestratorRouteKey,
  OrchestratorRoutes,
  ScheduleConsumerKind,
} from "./types"

type MutableOrchestratorRoute = {
  eventType: DomainEvent["type"]
  jobs: OrchestratorJob[]
  eventSchedules?: Array<{
    schedule: OrchestratorEventScheduleBinding["schedule"]
    targets: OrchestratorEventScheduleTarget[]
  }>
}

type MutableOrchestratorRoutes = Map<OrchestratorRouteKey, MutableOrchestratorRoute>

/** Compiles the declarative schedule graph into event-scoped queue routes. */
export function compileRoutes(params: CompileRoutesParams): OrchestratorRoutes {
  return compileRoutesWithDiagnostics(params).routes
}

export function compileRoutesWithDiagnostics(params: CompileRoutesParams): CompileRoutesResult {
  const routes: MutableOrchestratorRoutes = new Map()
  const diagnostics: CompileRoutesDiagnostic[] = []
  const schedulesById = new Map(params.schedules.map((schedule) => [schedule.id, schedule]))

  for (const sync of params.syncs) {
    for (const reference of sync.triggers) {
      addScheduleTarget({
        routes,
        diagnostics,
        schedulesById,
        reference,
        consumerKind: "sync",
        consumerId: sync.id,
        target: { queue: "syncRuns", syncId: sync.id },
      })
    }
  }

  for (const pipeline of params.pipelines) {
    for (const reference of pipeline.triggers) {
      addScheduleTarget({
        routes,
        diagnostics,
        schedulesById,
        reference,
        consumerKind: "pipeline",
        consumerId: pipeline.id,
        target: { queue: "pipelines", pipelineId: pipeline.id },
      })
    }
  }

  for (const workflow of params.workflows ?? []) {
    for (const reference of workflow.triggers) {
      const inputFields = Object.keys(workflow.input)
      if (reference.mapper === undefined && inputFields.length > 0) {
        diagnostics.push({
          type: "workflow.schedule.input-required",
          workflowId: workflow.id,
          scheduleId: reference.scheduleId,
          inputFields,
        })
        continue
      }

      addScheduleTarget({
        routes,
        diagnostics,
        schedulesById,
        reference,
        consumerKind: "workflow",
        consumerId: workflow.id,
        target: {
          queue: "workflows",
          workflowId: workflow.id,
          ...(reference.mapper !== undefined ? { mapper: reference.mapper } : {}),
        },
      })
    }
  }

  for (const projection of params.projections ?? []) {
    addDatasetVersionCommittedRouteJob(routes, projection.datasetId, {
      queue: "projections",
      job: {
        type: "projection.run.requested",
        payload: projection,
      },
    })
  }

  return { routes, diagnostics }
}

function addScheduleTarget(input: {
  routes: MutableOrchestratorRoutes
  diagnostics: CompileRoutesDiagnostic[]
  schedulesById: ReadonlyMap<string, ScheduleDefinition>
  reference: ScheduleReference
  consumerKind: ScheduleConsumerKind
  consumerId: string
  target: OrchestratorEventScheduleTarget
}): void {
  const schedule = input.schedulesById.get(input.reference.scheduleId)
  if (!schedule) {
    input.diagnostics.push({
      type: "schedule.reference.unknown",
      scheduleId: input.reference.scheduleId,
      consumerKind: input.consumerKind,
      consumerId: input.consumerId,
    })
    return
  }

  if (schedule.trigger.type === "cron") {
    addScheduleRouteJob(input.routes, schedule.id, eventScheduleTargetToJob(input.target))
    return
  }

  const eventSchedule = schedule as OrchestratorEventScheduleBinding["schedule"]

  for (const eventType of eventScheduleSubscribedEventTypes(eventSchedule)) {
    const key = eventScheduleRouteKeyForSelector(eventType, eventSchedule.trigger.source)
    if (!key) {
      throw new OrchestratorError(
        `Schedule '${schedule.id}' source cannot be compiled into a scoped route.`
      )
    }
    addCompiledEventSchedule(input.routes, { key, eventType }, eventSchedule, input.target)
  }
}

function eventScheduleTargetToJob(target: OrchestratorEventScheduleTarget): OrchestratorJob {
  switch (target.queue) {
    case "syncRuns":
      return {
        queue: "syncRuns",
        job: { type: "sync.run.requested", payload: { syncId: target.syncId } },
      }
    case "pipelines":
      return {
        queue: "pipelines",
        job: { type: "pipeline.run.requested", payload: { pipelineId: target.pipelineId } },
      }
    case "workflows":
      return {
        queue: "workflows",
        job: {
          type: "workflow.run.requested",
          payload: { workflowId: target.workflowId, input: {} },
        },
      }
  }
}

function addScheduleRouteJob(
  routes: MutableOrchestratorRoutes,
  scheduleId: string,
  job: OrchestratorJob
): void {
  addCompiledRouteJob(
    routes,
    { key: `schedule.triggered:${scheduleId}`, eventType: "schedule.triggered" },
    job
  )
}

function addCompiledRouteJob(
  routes: MutableOrchestratorRoutes,
  route: { key: OrchestratorRouteKey; eventType: DomainEvent["type"] },
  job: OrchestratorJob
): void {
  const existing = routes.get(route.key)
  if (existing) {
    existing.jobs.push(job)
    return
  }
  routes.set(route.key, { eventType: route.eventType, jobs: [job] })
}

function addCompiledEventSchedule(
  routes: MutableOrchestratorRoutes,
  route: { key: OrchestratorRouteKey; eventType: DomainEvent["type"] },
  schedule: OrchestratorEventScheduleBinding["schedule"],
  target: OrchestratorEventScheduleTarget
): void {
  const existing = routes.get(route.key)
  if (!existing) {
    routes.set(route.key, {
      eventType: route.eventType,
      jobs: [],
      eventSchedules: [{ schedule, targets: [target] }],
    })
    return
  }

  existing.eventSchedules ??= []
  const binding = existing.eventSchedules.find((candidate) => candidate.schedule.id === schedule.id)
  if (binding) {
    binding.targets.push(target)
    return
  }
  existing.eventSchedules.push({ schedule, targets: [target] })
}

function addDatasetVersionCommittedRouteJob(
  routes: MutableOrchestratorRoutes,
  datasetId: string,
  job: OrchestratorJob
): void {
  addCompiledRouteJob(
    routes,
    {
      key: `dataset.version.committed:${datasetId}`,
      eventType: "dataset.version.committed",
    },
    job
  )
}
