import type { AgentToolRuntimeFacade, Sixb } from "@sixb/core"
import { createObjectReadFacade } from "@sixb/core/internal/actions"
import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import type { AgentExecutionAuthorization } from "@sixb/core/internal/agents"
import type { ExecutionRecord } from "@sixb/core/storage"
import type { AgentExecutionContext, AgentWorkerContext, AgentWorkerHost } from "./types"

export function createAgentExecutionContext(input: {
  readonly context: AgentWorkerContext
  readonly host: AgentWorkerHost
  readonly execution: ExecutionRecord
  readonly actorId?: string
  readonly runId: string
  readonly authorization: AgentExecutionAuthorization
  readonly authorPrincipal?: AgentExecutionContext["authorPrincipal"]
}): AgentExecutionContext {
  const sixb = bindDurableAgentExecution(input.host, {
    execution: input.execution,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    runId: input.runId,
    authorization: input.authorization,
  })

  return {
    ...input.context,
    sixb,
    ...(input.authorPrincipal === undefined ? {} : { authorPrincipal: input.authorPrincipal }),
    blobStorage: sixb.blobs,
  }
}

/**
 * Narrow the run's SDK to what agent tools may call. A handler cannot reach past the facade into
 * operations the run must not perform directly, such as writing data without an action, reaching
 * blobs by id regardless of the requester, or starting workflows.
 */
export function agentToolRuntime(sixb: Sixb): AgentToolRuntimeFacade {
  const read = createObjectReadFacade(sixb, {
    resolveObjectType: (objectTypeId) => sixb.objects.resolveType(objectTypeId),
    getHistoryBatch: (input) => sixb.objects.getTelemetryHistoryBatch(input),
  })
  const { datasets } = sixb
  return Object.freeze({
    objects: read.objects,
    telemetry: read.telemetry,
    actions: sixb.actions,
    datasets: Object.freeze({
      list: () => datasets.list(),
      getById: (datasetId: string) => datasets.getById(datasetId),
      readRows: (...args: Parameters<typeof datasets.readRows>) => datasets.readRows(...args),
    }),
    connector: sixb.connector,
  })
}
