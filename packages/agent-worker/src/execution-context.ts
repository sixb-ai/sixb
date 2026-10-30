import { type AgentExecutionContext, agentRequester } from "@sixb/agent"
import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import type {
  AgentExecutionAuthorization,
  AgentRunFileStore,
  AgentRunSession,
} from "@sixb/core/internal/agents"
import type { ExecutionRecord } from "@sixb/core/storage"
import type { AgentRunnerContext, AgentWorkerContext, AgentWorkerHost } from "./types"

export async function createAgentExecutionContext(input: {
  readonly context: AgentWorkerContext
  readonly host: AgentWorkerHost
  readonly execution: ExecutionRecord
  readonly actorId?: string
  readonly runId: string
  /** Who the run's requester is, named in its prompt. */
  /** Display names the run read as it started (`AgentTurnContext.names`), its requester's among them. */
  readonly names: Readonly<Record<string, string>>
  readonly authorization: AgentExecutionAuthorization
  /** Where the run's files are stored: its session's. A workflow step stores through its SDK. */
  readonly files?: AgentRunFileStore
  readonly authorPrincipal?: AgentRunnerContext["authorPrincipal"]
  /** Others take part in the run's thread, so each user message names its author instead. */
  readonly shared?: boolean
}): Promise<AgentRunnerContext> {
  const sixb = bindDurableAgentExecution(input.host, {
    execution: input.execution,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    runId: input.runId,
    authorization: input.authorization,
  })

  // A shared thread's system prompt names nobody, so it stays the same whoever sends the turn.
  const requester = input.shared
    ? undefined
    : agentRequester(input.execution.requestedBy, input.names)

  // The run reaches shared state through its session, never through storage.
  const { storage: _storage, ...worker } = input.context
  return {
    ...worker,
    sixb,
    ...(input.authorPrincipal === undefined ? {} : { authorPrincipal: input.authorPrincipal }),
    ...(requester === undefined ? {} : { requester }),
    blobStorage: input.files ?? sixb.blobs,
  }
}

/**
 * A turn's or child's context, with what the worker's sandboxes need besides: its factory, and the
 * run's SDK, which resolves a workspace recipe's parameters.
 */
export async function runnerContext(
  host: AgentWorkerHost,
  context: AgentWorkerContext,
  run: {
    readonly session: AgentRunSession
    readonly context: AgentExecutionContext
    readonly execution: ExecutionRecord
  }
): Promise<AgentRunnerContext> {
  return {
    ...run.context,
    sandboxes: context.sandboxes,
    sixb: bindDurableAgentExecution(host, {
      execution: run.execution,
      runId: run.session.run.id,
      authorization: await run.session.authorization(run.execution.authorizationRef),
    }),
  }
}
