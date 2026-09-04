import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import type { AgentExecutionAuthorization } from "@sixb/core/internal/agents"
import type { ExecutionRecord } from "@sixb/core/storage"
import type { AgentExecutionContext, AgentWorkerContext, AgentWorkerHost } from "./types"

export function createAgentExecutionContext(input: {
  readonly context: AgentWorkerContext
  readonly host: AgentWorkerHost
  readonly execution: ExecutionRecord
  readonly agentId: string
  readonly runId: string
  readonly authorization: AgentExecutionAuthorization
  readonly authorPrincipal?: AgentExecutionContext["authorPrincipal"]
}): AgentExecutionContext {
  const sixb = bindDurableAgentExecution(input.host, {
    execution: input.execution,
    agentId: input.agentId,
    runId: input.runId,
    authorization: input.authorization,
  })

  return {
    ...input.context,
    ...(input.authorPrincipal === undefined ? {} : { authorPrincipal: input.authorPrincipal }),
    blobStorage: sixb.blobs,
    connector: sixb.connector,
  }
}
