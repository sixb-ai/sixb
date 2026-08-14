import type { AuthorizationContext } from "@sixb/core"
import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import type { ExecutionRecord } from "@sixb/core/storage"
import type {
  AgentExecutionContext,
  AgentPrincipal,
  AgentWorkerContext,
  AgentWorkerHost,
} from "./types"

export function createAgentExecutionContext(input: {
  readonly context: AgentWorkerContext
  readonly host: AgentWorkerHost
  readonly execution: ExecutionRecord
  readonly agentId: string
  readonly runId: string
  readonly authorization: AuthorizationContext
  readonly agentPrincipal: AgentPrincipal
}): AgentExecutionContext {
  const sixb = bindDurableAgentExecution(input.host, {
    execution: input.execution,
    agentId: input.agentId,
    runId: input.runId,
    authorization: input.authorization,
  })

  return {
    ...input.context,
    agentPrincipal: input.agentPrincipal,
    blobStorage: sixb.blobs,
    connector: sixb.connector,
  }
}
