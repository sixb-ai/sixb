import {
  type DomainEvent,
  type DomainTriggerDefinition,
  projectionKindOf,
  type RunTrigger,
  triggerSubscribedEventTypes,
} from "@sixb/core"
import type {
  CompileRoutesDiagnostic,
  CompileRoutesParams,
  CompileRoutesResult,
  OrchestratorJob,
  OrchestratorRouteKey,
  OrchestratorRoutes,
  OrchestratorWorkflowTriggerBinding,
} from "./types"

type MutableOrchestratorRoute = {
  eventType: DomainEvent["type"]
  jobs: OrchestratorJob[]
  workflowTriggers?: OrchestratorWorkflowTriggerBinding[]
}

type MutableOrchestratorRoutes = Map<OrchestratorRouteKey, MutableOrchestratorRoute>
type NonScheduleRunTrigger = Exclude<RunTrigger, { readonly type: "schedule" }>

/**
 * Compiles a static routing table from declared syncs, pipelines, workflows, and projections.
 * Syncs and pipelines are routed from their triggers; workflows are routed from eligible
 * schedule triggers; projections are routed by dataset id.
 * Safe to call at startup; the result is frozen at compile time.
 */
export function compileRoutes(params: CompileRoutesParams): OrchestratorRoutes {
  return compileRoutesWithDiagnostics(params).routes
}

export function compileRoutesWithDiagnostics(params: CompileRoutesParams): CompileRoutesResult {
  const routes: MutableOrchestratorRoutes = new Map()
  const diagnostics: CompileRoutesDiagnostic[] = []
  const triggersById = new Map((params.triggers ?? []).map((trigger) => [trigger.id, trigger]))

  for (const sync of params.syncs) {
    for (const trigger of sync.triggers) {
      addRouteJob(routes, trigger, {
        queue: "syncRuns",
        job: { type: "sync.run.requested", payload: { syncId: sync.id } },
      })
    }
  }

  for (const pipeline of params.pipelines) {
    for (const trigger of pipeline.triggers) {
      addRouteJob(routes, trigger, {
        queue: "pipelines",
        job: { type: "pipeline.run.requested", payload: { pipelineId: pipeline.id } },
      })
    }
  }

  for (const workflow of params.workflows ?? []) {
    for (const trigger of workflow.triggers) {
      if (trigger.type === "trigger") {
        const definition = triggersById.get(trigger.triggerId)
        if (!definition) {
          diagnostics.push({
            type: "workflow.trigger.unknown",
            workflowId: workflow.id,
            triggerId: trigger.triggerId,
          })
          continue
        }

        addTriggerWorkflowRouteBinding(routes, definition, {
          workflowId: workflow.id,
          triggerId: trigger.triggerId,
        })
        continue
      }

      if (trigger.type !== "schedule") continue

      const inputFields = Object.keys(workflow.input)
      if (inputFields.length > 0) {
        diagnostics.push({
          type: "workflow.schedule.input-required",
          workflowId: workflow.id,
          scheduleId: trigger.scheduleId,
          inputFields,
        })
        continue
      }

      addScheduleRouteJob(routes, trigger.scheduleId, {
        queue: "workflows",
        job: {
          type: "workflow.run.requested",
          payload: {
            workflowId: workflow.id,
            input: {},
          },
        },
      })
    }
  }

  for (const projection of params.projections ?? []) {
    addDatasetVersionCommittedRouteJob(routes, projection.datasetId, {
      queue: "projections",
      job: {
        type: "projection.run.requested",
        payload: {
          projectionId: projection.id,
          projectionKind: projectionKindOf(projection),
          datasetId: projection.datasetId,
        },
      },
    })
  }

  return { routes, diagnostics }
}

function addRouteJob(
  routes: MutableOrchestratorRoutes,
  trigger: RunTrigger,
  job: OrchestratorJob
): void {
  if (trigger.type === "schedule") {
    addScheduleRouteJob(routes, trigger.scheduleId, job)
    return
  }

  const route = triggerToRoute(trigger)
  addCompiledRouteJob(routes, route, job)
}

function addScheduleRouteJob(
  routes: MutableOrchestratorRoutes,
  scheduleId: string,
  job: OrchestratorJob
): void {
  addCompiledRouteJob(
    routes,
    {
      key: `schedule.triggered:${scheduleId}`,
      eventType: "schedule.triggered",
    },
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

  routes.set(route.key, {
    eventType: route.eventType,
    jobs: [job],
  })
}

function addTriggerWorkflowRouteBinding(
  routes: MutableOrchestratorRoutes,
  trigger: DomainTriggerDefinition,
  binding: OrchestratorWorkflowTriggerBinding
): void {
  for (const eventType of triggerSubscribedEventTypes(trigger)) {
    addCompiledRouteWorkflowTrigger(
      routes,
      {
        key: `trigger:${eventType}`,
        eventType,
      },
      binding
    )
  }
}

function addCompiledRouteWorkflowTrigger(
  routes: MutableOrchestratorRoutes,
  route: { key: OrchestratorRouteKey; eventType: DomainEvent["type"] },
  binding: OrchestratorWorkflowTriggerBinding
): void {
  const existing = routes.get(route.key)
  if (existing) {
    existing.workflowTriggers ??= []
    existing.workflowTriggers.push(binding)
    return
  }

  routes.set(route.key, {
    eventType: route.eventType,
    jobs: [],
    workflowTriggers: [binding],
  })
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

function triggerToRoute(trigger: NonScheduleRunTrigger): {
  key: OrchestratorRouteKey
  eventType: DomainEvent["type"]
} {
  switch (trigger.type) {
    case "sync.finished":
      return {
        key: `sync.run.finished:${trigger.syncId}:${trigger.status}`,
        eventType: "sync.run.finished",
      }
    case "pipeline.finished":
      return {
        key: `pipeline.run.finished:${trigger.pipelineId}:${trigger.status}`,
        eventType: "pipeline.run.finished",
      }
    case "dataset.updated":
      return {
        key: `dataset.version.committed:${trigger.datasetId}`,
        eventType: "dataset.version.committed",
      }
  }
}
