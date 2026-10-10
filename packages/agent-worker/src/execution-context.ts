import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import {
  type AgentExecutionAuthorization,
  resolveAgentPropertyClearance,
} from "@sixb/core/internal/agents"
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

  const propertyClearance = resolveAgentPropertyClearance(
    input.host.definitions.ontology,
    input.authorization
  )
  return {
    ...input.context,
    sixb,
    ...(propertyClearance === undefined ? {} : { propertyClearance }),
    ...(input.authorPrincipal === undefined ? {} : { authorPrincipal: input.authorPrincipal }),
    blobStorage: sixb.blobs,
    connector: sixb.connector,
  }
}
