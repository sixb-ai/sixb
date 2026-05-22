import { ActionWorker } from "@pario/action-worker"
import { assertLakeDatasetDefinitionsCompatible, migrateStorage } from "@pario/core"
import {
  type CompileRoutesDiagnostic,
  compileRoutesWithDiagnostics,
  OrchestratorWorker,
} from "@pario/orchestrator"
import { PipelineWorker } from "@pario/pipeline-worker"
import { ProjectionWorker } from "@pario/projection-worker"
import { RulesWorker } from "@pario/rules-worker"
import { SyncWorker } from "@pario/sync-worker"
import { WorkflowWorker } from "@pario/workflow-worker"
import type { LoadedPario } from "./loadPario"

export async function stopQuietly(stopFn: (() => Promise<void>) | undefined | null): Promise<void> {
  if (!stopFn) return
  await stopFn().catch(() => {})
}

export interface RunningParioRuntime {
  readonly rulesWorker: RulesWorker | null
  readonly syncWorker: SyncWorker | null
  readonly actionWorker: ActionWorker | null
  readonly projectionWorker: ProjectionWorker | null
  readonly pipelineWorker: PipelineWorker | null
  readonly workflowWorker: WorkflowWorker | null
  readonly orchestratorWorker: OrchestratorWorker | null
  readonly warnings: readonly string[]
  stop(): Promise<void>
}

export interface StartParioRuntimeOptions {
  readonly cohostWorkers?: boolean
}

/**
 * Starts the background runtimes owned by the CLI host.
 *
 * Startup order (consumers before producers):
 *   1. RulesWorker (subscribes to ontology events)
 *   2. Functions
 *   3. ActionWorker (subscribes to events)
 *   4. ProjectionWorker (claims from queues)
 *   5. PipelineWorker (claims from queues)
 *   6. WorkflowWorker (claims from queues)
 *   7. SyncWorker (claims from queues)
 *   8. Orchestrator (subscribes to events and enqueues jobs)
 *   9. Scheduler (emits schedule.triggered)
 *
 * Shutdown order (producers before consumers):
 *   1. Scheduler
 *   2. Orchestrator (drains pending dispatches)
 *   3. SyncWorker
 *   4. WorkflowWorker
 *   5. PipelineWorker
 *   6. ProjectionWorker
 *   7. ActionWorker
 *   8. Functions
 *   9. RulesWorker (drains pending evaluations)
 *   10. Runtime providers (connectors, broker)
 */
export async function startParioRuntime(
  pario: LoadedPario,
  options: StartParioRuntimeOptions = {}
): Promise<RunningParioRuntime> {
  await migrateStorage(pario.storage)
  await assertLakeDatasetDefinitionsCompatible({
    lakeStorage: pario.lakeStorage,
    definitions: pario.getDatasetDefinitions(),
  })

  let rulesWorker: RulesWorker | null = null
  let syncWorker: SyncWorker | null = null
  let actionWorker: ActionWorker | null = null
  let pipelineWorker: PipelineWorker | null = null
  let workflowWorker: WorkflowWorker | null = null
  let orchestratorWorker: OrchestratorWorker | null = null
  let projectionWorker: ProjectionWorker | null = null
  const warnings: string[] = []

  async function stop() {
    await stopQuietly(() => (options.cohostWorkers ? pario.stopScheduler() : Promise.resolve()))
    await stopQuietly(() => orchestratorWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => syncWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => workflowWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => pipelineWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => projectionWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => actionWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => pario.stopFunctions())
    await stopQuietly(() => rulesWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => pario.disconnectConnectors())
    await stopQuietly(() => pario.closeBroker())
  }

  try {
    if (pario.getRuleDefinitions().length > 0) {
      rulesWorker = new RulesWorker(pario)
      await rulesWorker.start()
    }

    await pario.startFunctions()

    if (options.cohostWorkers) {
      const { routes, diagnostics } = compileRoutesWithDiagnostics({
        syncs: pario.getSyncDefinitions(),
        pipelines: pario.getPipelineDefinitions(),
        projections: [...pario.getObjectProjections(), ...pario.getLinkProjections()],
        workflows: pario.getWorkflowDefinitions(),
      })
      warnings.push(...diagnostics.map(formatRouteDiagnosticWarning))

      if (pario.getActionDefinitions().length > 0) {
        actionWorker = new ActionWorker(pario)
        await actionWorker.start()
      }

      const projectionCount =
        pario.getObjectProjections().length + pario.getLinkProjections().length
      if (projectionCount > 0) {
        projectionWorker = new ProjectionWorker(pario)
        await projectionWorker.start()
      }

      if (pario.getPipelineDefinitions().length > 0) {
        pipelineWorker = new PipelineWorker(pario)
        await pipelineWorker.start()
      }

      if (pario.getWorkflowDefinitions().length > 0) {
        workflowWorker = new WorkflowWorker(pario)
        await workflowWorker.start()
      }

      if (pario.getSyncDefinitions().length > 0) {
        syncWorker = new SyncWorker(pario)
        await syncWorker.start()
      }

      if (routes.size > 0) {
        orchestratorWorker = new OrchestratorWorker({
          projectId: pario.id,
          events: pario.events,
          queues: pario.queues,
          routes,
        })
        await orchestratorWorker.start()
      }

      await pario.startScheduler()
    }
  } catch (error) {
    await stop()
    throw error
  }

  return {
    rulesWorker,
    syncWorker,
    actionWorker,
    projectionWorker,
    pipelineWorker,
    workflowWorker,
    orchestratorWorker,
    warnings,
    stop,
  }
}

function formatRouteDiagnosticWarning(diagnostic: CompileRoutesDiagnostic): string {
  switch (diagnostic.type) {
    case "workflow.schedule.input-required":
      return `[Pario] Workflow '${diagnostic.workflowId}' is scheduled but has non-empty input (${diagnostic.inputFields.join(", ")}); it was not auto-routed.`
  }
}

export async function runUntilSignal(onShutdown: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false

    const shutdown = async () => {
      if (shuttingDown) return
      shuttingDown = true
      await onShutdown()
      resolvePromise()
    }

    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
  })
}
