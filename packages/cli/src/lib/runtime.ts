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

async function closeProvider(provider: unknown): Promise<void> {
  const close = (provider as { close?: unknown } | null | undefined)?.close
  if (typeof close !== "function") return
  await close.call(provider)
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

export interface RunningRulesRuntime {
  readonly rulesWorker: RulesWorker | null
  stop(): Promise<void>
}

export interface RunningFunctionsRuntime {
  stop(): Promise<void>
}

export interface RunningSchedulerRuntime {
  stop(): Promise<void>
}

export interface RunningOrchestratorRuntime {
  readonly orchestratorWorker: OrchestratorWorker | null
  readonly warnings: readonly string[]
  stop(): Promise<void>
}

export async function prepareParioRuntime(pario: LoadedPario): Promise<void> {
  await migrateStorage(pario.storage)
  await assertLakeDatasetDefinitionsCompatible({
    lakeStorage: pario.lakeStorage,
    definitions: pario.getDatasetDefinitions(),
  })
}

export async function stopParioProviders(pario: LoadedPario): Promise<void> {
  await stopQuietly(() => pario.disconnectConnectors())
  await stopQuietly(() => closeProvider(pario.queues))
  await stopQuietly(() => closeProvider(pario.storage))
  await stopQuietly(() => closeProvider(pario.lakeStorage))
  await stopQuietly(() => closeProvider(pario.blobStorage))
  await stopQuietly(() => pario.closeBroker())
}

export async function startRulesRuntime(pario: LoadedPario): Promise<RunningRulesRuntime> {
  let rulesWorker: RulesWorker | null = null

  if (pario.getRuleDefinitions().length > 0) {
    rulesWorker = new RulesWorker(pario)
    await rulesWorker.start()
  }

  return {
    rulesWorker,
    async stop() {
      await stopQuietly(() => rulesWorker?.stop() ?? Promise.resolve())
    },
  }
}

export async function startFunctionsRuntime(pario: LoadedPario): Promise<RunningFunctionsRuntime> {
  await pario.startFunctions()

  return {
    async stop() {
      await stopQuietly(() => pario.stopFunctions())
    },
  }
}

export async function startSchedulerRuntime(pario: LoadedPario): Promise<RunningSchedulerRuntime> {
  await pario.startScheduler()

  return {
    async stop() {
      await stopQuietly(() => pario.stopScheduler())
    },
  }
}

export async function startOrchestratorRuntime(
  pario: LoadedPario
): Promise<RunningOrchestratorRuntime> {
  const { routes, diagnostics } = compileRoutesWithDiagnostics({
    syncs: pario.getSyncDefinitions(),
    pipelines: pario.getPipelineDefinitions(),
    projections: [...pario.getObjectProjections(), ...pario.getLinkProjections()],
    workflows: pario.getWorkflowDefinitions(),
  })
  const warnings = diagnostics.map(formatRouteDiagnosticWarning)
  let orchestratorWorker: OrchestratorWorker | null = null

  if (routes.size > 0) {
    orchestratorWorker = new OrchestratorWorker({
      projectId: pario.id,
      events: pario.events,
      queues: pario.queues,
      routes,
    })
    await orchestratorWorker.start()
  }

  return {
    orchestratorWorker,
    warnings,
    async stop() {
      await stopQuietly(() => orchestratorWorker?.stop() ?? Promise.resolve())
    },
  }
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
  await prepareParioRuntime(pario)

  let rulesRuntime: RunningRulesRuntime | null = null
  let functionsRuntime: RunningFunctionsRuntime | null = null
  let schedulerRuntime: RunningSchedulerRuntime | null = null
  let orchestratorRuntime: RunningOrchestratorRuntime | null = null
  let rulesWorker: RulesWorker | null = null
  let syncWorker: SyncWorker | null = null
  let actionWorker: ActionWorker | null = null
  let pipelineWorker: PipelineWorker | null = null
  let workflowWorker: WorkflowWorker | null = null
  let orchestratorWorker: OrchestratorWorker | null = null
  let projectionWorker: ProjectionWorker | null = null
  const warnings: string[] = []

  async function stop() {
    await stopQuietly(() => schedulerRuntime?.stop() ?? Promise.resolve())
    await stopQuietly(() => orchestratorRuntime?.stop() ?? Promise.resolve())
    await stopQuietly(() => syncWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => workflowWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => pipelineWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => projectionWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => actionWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => functionsRuntime?.stop() ?? Promise.resolve())
    await stopQuietly(() => rulesRuntime?.stop() ?? Promise.resolve())
    await stopParioProviders(pario)
  }

  try {
    rulesRuntime = await startRulesRuntime(pario)
    rulesWorker = rulesRuntime.rulesWorker

    functionsRuntime = await startFunctionsRuntime(pario)

    if (options.cohostWorkers) {
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

      orchestratorRuntime = await startOrchestratorRuntime(pario)
      orchestratorWorker = orchestratorRuntime.orchestratorWorker
      warnings.push(...orchestratorRuntime.warnings)

      schedulerRuntime = await startSchedulerRuntime(pario)
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
