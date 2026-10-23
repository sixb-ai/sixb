import { principalsEqual } from "../auth/types"
import type { FileRef } from "../blob-storage/types"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ExecutionRecord } from "../storage/executions"

/** The files one model call produced. */
export interface ModelCallFiles {
  readonly callId: string
  readonly files: readonly FileRef[]
  readonly recordedAt: Date
}

export interface ModelCallsRuntime {
  /**
   * The files a call produced, when the caller can see the run that made it: the request's own
   * principal, the agent thread's readers, or the action or workflow run's viewers. Null when the
   * call produced none or is hidden; usage observers see a call's cost, not its content.
   */
  files(callId: string): Promise<ModelCallFiles | null>
}

/** Whether the caller sees a run, as the runtime's own run lookups decide it. */
export interface ModelCallRunVisibility {
  canViewActionRun(runId: string): Promise<boolean>
  canViewWorkflowRun(runId: string): Promise<boolean>
  /** A conversation run: visible to whoever can read its thread. */
  canViewAgentRun(runId: string): Promise<boolean>
}

// Subagents nest; a chain longer than this is a storage fault, not a deeper delegation.
const MAX_SUBAGENT_DEPTH = 32

export function createModelCallsRuntime(
  runtime: Pick<SixbRuntimeContext, "projectId" | "runtimeAuthorization" | "storage">,
  runs: ModelCallRunVisibility,
  /** The execution reading; it reads what it produced, whoever can see its run. */
  executionId?: string
): ModelCallsRuntime {
  const projectId = runtime.projectId

  async function canRead(execution: ExecutionRecord): Promise<boolean> {
    const authority = resolveRuntimeAuthorizationForProject(runtime)
    if (authority.type === "unrestricted") return true
    if (authority.type !== "principal") return false

    const executor = execution.executor
    if (executor.type === "request") {
      return (
        execution.requestedBy !== undefined &&
        principalsEqual(authority.context.principal, execution.requestedBy)
      )
    }
    if (executor.type === "primitive") {
      if (executor.kind === "action") return runs.canViewActionRun(executor.runId)
      if (executor.kind === "workflow") return runs.canViewWorkflowRun(executor.runId)
      return false
    }
    if (executor.type === "agent") return canReadAgentRun(executor.runId)
    return false
  }

  async function canReadAgentRun(runId: string): Promise<boolean> {
    const agents = runtime.storage.agents
    let id = runId
    for (let depth = 0; depth < MAX_SUBAGENT_DEPTH; depth += 1) {
      const run = agents ? await agents.runs.getById({ projectId, id }) : null
      if (run?.kind === "conversation") return runs.canViewAgentRun(run.id)
      if (run?.kind === "subagent") {
        id = run.parentRunId
        continue
      }
      // A workflow's agent step runs as a node of that workflow's run.
      const node = await runtime.storage.workflowRuns?.nodes.getById({ projectId, id })
      return node ? runs.canViewWorkflowRun(node.workflowRunId) : false
    }
    return false
  }

  return {
    async files(callId) {
      if (typeof callId !== "string" || !callId.trim()) {
        throw new TypeError("[SixbModels] A model call ID must be a nonblank string.")
      }
      const record = await runtime.storage.aiUsage?.getModelCallFiles({ projectId, callId })
      if (!record) return null

      // A workflow's agent step runs as a service account that cannot view its own workflow run,
      // yet must read back the image it just made.
      const visible = { callId: record.callId, files: record.files, recordedAt: record.recordedAt }
      if (record.executionId === executionId) return visible

      const execution = await runtime.storage.executions.getById({
        projectId,
        id: record.executionId,
      })
      return execution && (await canRead(execution)) ? visible : null
    },
  }
}
