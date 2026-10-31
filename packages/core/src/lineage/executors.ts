import { canReadActionRunSubject, viewableActionRuns } from "../actions/run-authorization"
import { createAgentThreadAccessRule } from "../agents/thread-access"
import type { EventExecutor } from "../materialization/events"
import type { ProjectionDefinitionCatalog } from "../projections"
import { projectionTargetOf } from "../projections/builders"
import type { LineageReader } from "./reader"

/**
 * The key a run is counted under once hidden, for an executor that names one: a primitive's run or
 * an Agent run. A request or a kernel operation names none.
 */
export function executorRunKey(executor: EventExecutor): string | undefined {
  switch (executor.type) {
    case "primitive":
      return `${executor.kind}-run:${executor.runId}`
    case "agent":
      return `agent-run:${executor.runId}`
    case "request":
    case "kernel":
      return undefined
  }
}

/**
 * The keys of the runs these executors name that the reader may view, each decided as that run's
 * facade decides. One read per distinct Action or Agent run; the others are decided by definition.
 */
export async function viewableExecutorRuns(
  reader: LineageReader,
  projections: ProjectionDefinitionCatalog,
  executors: readonly EventExecutor[]
): Promise<ReadonlySet<string>> {
  const runs = new Map<string, EventExecutor>()
  for (const executor of executors) {
    const key = executorRunKey(executor)
    if (key !== undefined) runs.set(key, executor)
  }

  const decided = await Promise.all(
    [...runs].map(async ([key, executor]) => {
      const viewable = await canViewExecutorRun(reader, projections, executor)
      return viewable ? [key] : []
    })
  )

  return new Set(decided.flat())
}

async function canViewExecutorRun(
  reader: LineageReader,
  projections: ProjectionDefinitionCatalog,
  executor: EventExecutor
): Promise<boolean> {
  if (reader.authority.type === "unrestricted") return true

  switch (executor.type) {
    case "request":
    case "kernel":
      return true
    case "agent":
      return canViewAgentRun(reader, executor.runId)
    case "primitive":
      break
  }

  switch (executor.kind) {
    case "action":
      return canViewActionRun(reader, executor.runId)
    case "projection": {
      // A projection the code no longer defines has no target to decide by.
      const definition = projections.getById(executor.id)
      return (
        definition !== null &&
        reader.canViewRun({ kind: "projection", target: projectionTargetOf(definition) })
      )
    }
    default:
      return reader.canViewRun({ kind: executor.kind, id: executor.id })
  }
}

/** Decided as `actions.runs.getById` decides for a principal. */
async function canViewActionRun(reader: LineageReader, runId: string): Promise<boolean> {
  const { projectId, storage, objectReader } = reader.runtime
  if (reader.authority.type !== "principal") return false

  const run = await storage.actionRuns?.getById({ projectId, id: runId })
  if (!run) return false

  const [viewable] = await viewableActionRuns(objectReader, reader.authority.context, [run])
  return viewable !== undefined && (await canReadActionRunSubject(objectReader, run))
}

/** Decided as `agent.runs.getById` decides: by whether the reader reads the run's thread. */
async function canViewAgentRun(reader: LineageReader, runId: string): Promise<boolean> {
  const { projectId, storage } = reader.runtime

  const run = await storage.agents?.runs.getById({ projectId, id: runId })
  if (!run) return false

  const rule = createAgentThreadAccessRule(reader.runtime, reader.authority)
  return (await rule.read(run.threadId)) !== null
}
