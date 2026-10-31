import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import {
  type AgentExecutionAuthorization,
  type AgentRunPeople,
  resolveAgentPropertyClearance,
} from "@sixb/core/internal/agents"
import type { ExecutionRecord } from "@sixb/core/storage"
import { resolveAgentRequester } from "./requester"
import type { AgentExecutionContext, AgentWorkerContext, AgentWorkerHost } from "./types"

export async function createAgentExecutionContext(input: {
  readonly context: AgentWorkerContext
  readonly host: AgentWorkerHost
  readonly execution: ExecutionRecord
  readonly actorId?: string
  readonly runId: string
  /** Who the run's requester is, named in its prompt. */
  readonly people: Pick<AgentRunPeople, "user">
  readonly authorization: AgentExecutionAuthorization
  readonly authorPrincipal?: AgentExecutionContext["authorPrincipal"]
  /** Others take part in the run's thread, so each user message names its author instead. */
  readonly shared?: boolean
}): Promise<AgentExecutionContext> {
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
  // A shared thread's system prompt names nobody, so it stays the same whoever sends the turn.
  const requester = input.shared
    ? undefined
    : await resolveAgentRequester({
        people: input.people,
        requestedBy: input.execution.requestedBy,
      })

  // The run reaches shared state through its session; only publish_artifact keeps the storage.
  const { storage, ...worker } = input.context
  return {
    ...worker,
    artifactPublishing: storage,
    sixb,
    ...(propertyClearance === undefined ? {} : { propertyClearance }),
    ...(input.authorPrincipal === undefined ? {} : { authorPrincipal: input.authorPrincipal }),
    ...(requester === undefined ? {} : { requester }),
    blobStorage: sixb.blobs,
  }
}
