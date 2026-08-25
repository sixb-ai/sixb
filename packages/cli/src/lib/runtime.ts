import { appendFileSync } from "node:fs"
import { ActionWorker } from "@sixb/action-worker"
import { AgentWorker } from "@sixb/agent-worker"
import { migrateStorage } from "@sixb/core"
import { flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { PipelineRunDispatcher } from "@sixb/core/internal/pipelines"
import {
  getProjectionDispatchDescriptors,
  ProjectionRunDispatcher,
} from "@sixb/core/internal/projections"
import { SyncRunDispatcher } from "@sixb/core/internal/syncs"
import type { Worker } from "@sixb/core/internal/workers"
import { WorkflowRunDispatcher } from "@sixb/core/internal/workflows"
import { assertLakeDatasetDefinitionsCompatible } from "@sixb/core/lake-storage"
import {
  type CompileRoutesDiagnostic,
  compileRoutesWithDiagnostics,
  OrchestratorWorker,
} from "@sixb/orchestrator"
import { PipelineWorker } from "@sixb/pipeline-worker"
import { ProjectionWorker } from "@sixb/projection-worker"
import { RulesWorker } from "@sixb/rules-worker"
import { SyncWorker } from "@sixb/sync-worker"
import { WorkflowWorker } from "@sixb/workflow-worker"
import type { LoadedSixbHost } from "./loadSixb"

export function waitForWorkerFailure(worker: Worker | null | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    worker?.wait().catch(reject)
  })
}

export async function stopQuietly(stopFn: (() => Promise<void>) | undefined | null): Promise<void> {
  if (!stopFn) return
  await stopFn().catch(() => {})
}

async function closeProvider(provider: { close?(): void | Promise<void> }): Promise<void> {
  await provider.close?.()
}

export interface RunningSixbRuntime {
  readonly rulesWorker: RulesWorker | null
  readonly syncWorker: SyncWorker | null
  readonly actionWorker: ActionWorker | null
  readonly agentWorker: AgentWorker | null
  readonly projectionWorker: ProjectionWorker | null
  readonly pipelineWorker: PipelineWorker | null
  readonly workflowWorker: WorkflowWorker | null
  readonly orchestratorWorker: OrchestratorWorker | null
  readonly warnings: readonly string[]
  waitForWorkerFailure(): Promise<never>
  stop(): Promise<void>
}

export interface StartSixbRuntimeOptions {
  readonly cohostWorkers?: boolean
  readonly agentApiBaseUrl?: string
  readonly agentTurnTimeoutMs?: number
}

export interface RunningRulesRuntime {
  readonly rulesWorker: RulesWorker | null
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

export async function migrateRuntimeStorage(sixb: LoadedSixbHost): Promise<void> {
  await migrateStorage(sixb.storage)
}

export async function checkRuntimeLakeDefinitions(sixb: LoadedSixbHost): Promise<void> {
  await assertLakeDatasetDefinitionsCompatible({
    lakeStorage: sixb.lakeStorage,
    definitions: sixb.definitions.datasets.list(),
  })
}

export async function stopSixbProviders(sixb: LoadedSixbHost): Promise<void> {
  await stopQuietly(() => flushSixbErrors(sixb))
  await stopQuietly(() => sixb.closeConnectors())
  await stopQuietly(() => closeProvider(sixb.queues))
  // Stop tracked outbox publication before closing the storage it claims from.
  await stopQuietly(() => sixb.closeBroker())
  // The final outbox drain can report delivery failures after the initial error flush.
  await stopQuietly(() => flushSixbErrors(sixb))
  await stopQuietly(() => closeProvider(sixb.storage))
  await stopQuietly(() => closeProvider(sixb.lakeStorage))
  await stopQuietly(() => sixb.closeBlobs())
  await stopQuietly(() => sixb.closeLogger())
}

export async function startRulesRuntime(sixb: LoadedSixbHost): Promise<RunningRulesRuntime> {
  let rulesWorker: RulesWorker | null = null

  if (sixb.definitions.rules.list().length > 0) {
    rulesWorker = new RulesWorker(sixb)
    await rulesWorker.start()
  }

  return {
    rulesWorker,
    async stop() {
      await stopQuietly(() => rulesWorker?.stop() ?? Promise.resolve())
    },
  }
}

export async function startSchedulerRuntime(
  sixb: LoadedSixbHost
): Promise<RunningSchedulerRuntime> {
  await sixb.scheduler.start()

  return {
    async stop() {
      await stopQuietly(() => sixb.scheduler.stop())
    },
  }
}

export async function startOrchestratorRuntime(
  sixb: LoadedSixbHost
): Promise<RunningOrchestratorRuntime> {
  const projections = getProjectionDispatchDescriptors(sixb)
  const { routes, diagnostics } = compileRoutesWithDiagnostics({
    schedules: sixb.definitions.schedules.list(),
    syncs: sixb.definitions.syncs.list(),
    pipelines: sixb.definitions.pipelines.list(),
    projections,
    workflows: sixb.definitions.workflows.list(),
  })
  const warnings = diagnostics.map(formatRouteDiagnosticWarning)
  let orchestratorWorker: OrchestratorWorker | null = null

  if (routes.size > 0) {
    if (projections.length > 0 && !sixb.storage.projectionRuns) {
      throw new Error("[SixbCLI] Projection dispatch requires storage.projectionRuns.")
    }
    const projectionReconciliation =
      projections.length > 0 ? { lakeStorage: sixb.lakeStorage } : undefined
    orchestratorWorker = new OrchestratorWorker({
      projectId: sixb.id,
      events: sixb.events,
      queues: sixb.queues,
      routes,
      dispatchers: {
        syncs: new SyncRunDispatcher(sixb),
        pipelines: new PipelineRunDispatcher(sixb),
        projections: new ProjectionRunDispatcher(sixb),
        workflows: new WorkflowRunDispatcher(sixb),
      },
      ...(projectionReconciliation ? { projectionReconciliation } : {}),
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
 *   2. ActionWorker (subscribes to events)
 *   3. AgentWorker (claims from queues)
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
 *   7. AgentWorker
 *   8. ActionWorker
 *   9. RulesWorker (drains pending evaluations)
 *   10. Runtime providers (connectors, broker)
 */
export async function startSixbRuntime(
  sixb: LoadedSixbHost,
  options: StartSixbRuntimeOptions = {}
): Promise<RunningSixbRuntime> {
  await migrateRuntimeStorage(sixb)
  await checkRuntimeLakeDefinitions(sixb)

  let rulesRuntime: RunningRulesRuntime | null = null
  let schedulerRuntime: RunningSchedulerRuntime | null = null
  let orchestratorRuntime: RunningOrchestratorRuntime | null = null
  let rulesWorker: RulesWorker | null = null
  let syncWorker: SyncWorker | null = null
  let actionWorker: ActionWorker | null = null
  let agentWorker: AgentWorker | null = null
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
    await stopQuietly(() => agentWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => actionWorker?.stop() ?? Promise.resolve())
    await stopQuietly(() => rulesRuntime?.stop() ?? Promise.resolve())
    await stopSixbProviders(sixb)
  }

  try {
    rulesRuntime = await startRulesRuntime(sixb)
    rulesWorker = rulesRuntime.rulesWorker

    if (options.cohostWorkers) {
      if (sixb.definitions.actions.list().length > 0) {
        actionWorker = new ActionWorker(sixb)
        await actionWorker.start()
      }

      if (sixb.definitions.agents.list().length > 0 && sixb.storage.agents) {
        agentWorker = new AgentWorker(sixb, {
          apiBaseUrl: requireAgentApiBaseUrl(options.agentApiBaseUrl),
          turnTimeoutMs: options.agentTurnTimeoutMs,
        })
        await agentWorker.start()
      }

      const projectionCount = sixb.definitions.projections.list().length
      if (projectionCount > 0) {
        projectionWorker = new ProjectionWorker(sixb)
        await projectionWorker.start()
      }

      if (sixb.definitions.pipelines.list().length > 0) {
        pipelineWorker = new PipelineWorker(sixb)
        await pipelineWorker.start()
      }

      if (sixb.definitions.workflows.list().length > 0) {
        workflowWorker = new WorkflowWorker(sixb)
        await workflowWorker.start()
      }

      if (sixb.definitions.syncs.list().length > 0) {
        syncWorker = new SyncWorker(sixb)
        await syncWorker.start()
      }

      orchestratorRuntime = await startOrchestratorRuntime(sixb)
      orchestratorWorker = orchestratorRuntime.orchestratorWorker
      warnings.push(...orchestratorRuntime.warnings)

      schedulerRuntime = await startSchedulerRuntime(sixb)
    }
  } catch (error) {
    await stop()
    throw error
  }

  const activeWorkers = (): Worker[] => {
    const workers: Worker[] = []
    if (rulesWorker) workers.push(rulesWorker)
    if (syncWorker) workers.push(syncWorker)
    if (actionWorker) workers.push(actionWorker)
    if (agentWorker) workers.push(agentWorker)
    if (projectionWorker) workers.push(projectionWorker)
    if (pipelineWorker) workers.push(pipelineWorker)
    if (workflowWorker) workers.push(workflowWorker)
    if (orchestratorWorker) workers.push(orchestratorWorker)
    return workers
  }

  return {
    rulesWorker,
    syncWorker,
    actionWorker,
    agentWorker,
    projectionWorker,
    pipelineWorker,
    workflowWorker,
    orchestratorWorker,
    warnings,
    waitForWorkerFailure() {
      return Promise.race(activeWorkers().map(waitForWorkerFailure))
    },
    stop,
  }
}

function formatRouteDiagnosticWarning(diagnostic: CompileRoutesDiagnostic): string {
  switch (diagnostic.type) {
    case "workflow.schedule.input-required":
      return `[Sixb] Workflow '${diagnostic.workflowId}' is scheduled but has non-empty input (${diagnostic.inputFields.join(", ")}); it was not auto-routed.`
    case "schedule.reference.unknown":
      return `[Sixb] ${diagnostic.consumerKind} '${diagnostic.consumerId}' references unknown schedule '${diagnostic.scheduleId}'; it was not auto-routed.`
  }
}

function requireAgentApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error("[SixbCLI] Agent workers require an API public origin.")
  }
  return trimmed
}

export async function runUntilSignal(onShutdown: () => Promise<void>): Promise<void> {
  // Test-only readiness hook: e2e tests detect that a long-running role finished
  // starting by watching for this marker. It avoids depending on Ink's rendered
  // output, which is suppressed when stdout is not a TTY (e.g. under CI). Unset in
  // production, so this is a no-op there.
  const readyLog = process.env.SIXB_CLI_TEST_READY_LOG
  if (readyLog) {
    appendFileSync(readyLog, `${JSON.stringify({ type: "role:ready" })}\n`, "utf-8")
  }

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
