import { SYSTEM_PRINCIPAL } from "../auth"
import { agentServiceAccountId } from "../agents/authority"
import type { AuthStorage } from "../storage/auth"
import { AuthStorageError } from "../storage/auth"
import type { ExecutionStorage } from "../storage/executions"

/** Create the durable execution chain required by an Agent-run storage fixture. */
export async function createTestAgentExecution(
  storage: { readonly auth?: AuthStorage; readonly executions: ExecutionStorage },
  input: {
    readonly projectId: string
    readonly agentId: string
    readonly runId: string
    readonly executionId?: string
    readonly sourceExecutionId?: string
  }
): Promise<string> {
  const auth = storage.auth
  if (!auth) throw new Error("Agent execution fixtures require auth storage.")
  const serviceAccountId = agentServiceAccountId(input.agentId)
  const serviceAccount = await auth.serviceAccounts.getById({
    projectId: input.projectId,
    id: serviceAccountId,
  })
  if (!serviceAccount) {
    const now = new Date()
    try {
      await auth.serviceAccounts.create({
        id: serviceAccountId,
        projectId: input.projectId,
        name: `Test Agent ${input.agentId}`,
        description: `Test service account for Agent '${input.agentId}'.`,
        status: "active",
        createdByPrincipal: SYSTEM_PRINCIPAL,
        createdAt: now,
        updatedAt: now,
      })
    } catch (error) {
      if (!(error instanceof AuthStorageError) || error.code !== "duplicate_service_account") {
        throw error
      }
    }
  }

  const sourceExecutionId = input.sourceExecutionId ?? `test_request_execution:${input.runId}`
  const executionId = input.executionId ?? `test_agent_execution:${input.runId}`
  const existing = await storage.executions.getById({
    projectId: input.projectId,
    id: executionId,
  })
  if (existing) return executionId

  let parent = await storage.executions.getById({
    projectId: input.projectId,
    id: sourceExecutionId,
  })
  if (!parent) {
    parent = await storage.executions.create({
      id: sourceExecutionId,
      projectId: input.projectId,
      executor: { type: "request", requestId: `test_request:${input.runId}` },
      source: { type: "http", requestId: `test_request:${input.runId}` },
      correlationId: `test_correlation:${input.runId}`,
      authorizationRef: { type: "disabled" },
    })
  }
  await storage.executions.create({
    id: executionId,
    projectId: input.projectId,
    executor: { type: "agent", runId: input.runId },
    source: { type: "execution", executionId: sourceExecutionId },
    ...(parent.requestedBy === undefined
      ? {}
      : { requestedBy: structuredClone(parent.requestedBy) }),
    correlationId: parent.correlationId,
    authorizationRef: {
      type: "principal",
      principal: { type: "serviceAccount", id: serviceAccountId },
    },
  })
  return executionId
}
