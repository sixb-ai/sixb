import { agentServiceAccountId } from "../../agents/authority"
import type { ExecutionStorage } from "../executions"
import { findAgentRunExecution } from "../executions/run-link"
import { AgentStorageError } from "./errors"

/** Validate the semantic link between a conversational Agent run and its immutable execution. */
export async function assertAgentRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly agentId: string
}): Promise<void> {
  const execution = await findAgentRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    runId: input.runId,
    serviceAccountId: agentServiceAccountId(input.agentId),
  })
  if (!execution) {
    throw new AgentStorageError(
      "invalid_input",
      `[Sixb] Execution '${input.executionId}' does not authorize Agent run '${input.runId}'.`
    )
  }
}
