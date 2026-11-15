import { agentServiceAccountId } from "../agents/authority"
import { SYSTEM_PRINCIPAL, type UserPrincipal } from "../auth"
import type { AuthorizationRef } from "../execution"
import type { AuthStorage } from "../storage/auth"
import { AuthStorageError } from "../storage/auth"
import type { ExecutionStorage } from "../storage/executions"

/** Create the durable execution chain required by an Agent-run storage fixture. */
export async function createTestAgentExecution(
  storage: { readonly auth?: AuthStorage; readonly executions: ExecutionStorage },
  input: {
    readonly projectId: string
    readonly actorId?: string
    readonly runId: string
    readonly executionId?: string
    readonly sourceExecutionId?: string
    readonly requesterGroupIds?: readonly string[]
    /** Conversational runs inherit authority; workflow fixtures use managed authority. */
    readonly authority?: "managed" | "inherited"
    /** The person the run's request came from, signed in with a session; none by default. */
    readonly requestedBy?: UserPrincipal
  }
): Promise<string> {
  const authority = input.authority ?? (input.actorId === undefined ? "inherited" : "managed")
  if (authority === "managed" && input.actorId === undefined) {
    throw new Error("Managed Agent execution fixtures require an agent id.")
  }
  const serviceAccountId = input.actorId ? agentServiceAccountId(input.actorId) : undefined
  if (authority === "managed") {
    const auth = storage.auth
    if (!auth) throw new Error("Managed Agent execution fixtures require auth storage.")
    const serviceAccount = await auth.serviceAccounts.getById({
      projectId: input.projectId,
      id: serviceAccountId!,
    })
    if (!serviceAccount) {
      const now = new Date()
      try {
        await auth.serviceAccounts.create({
          id: serviceAccountId!,
          projectId: input.projectId,
          name: `Test Agent ${input.actorId}`,
          description: `Test service account for Agent '${input.actorId}'.`,
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
    const requestedBy = input.requestedBy
    const authorizationRef: AuthorizationRef = requestedBy
      ? {
          type: "principal",
          principal: requestedBy,
          credential: { type: "session", id: await ensureTestSession(storage, input, requestedBy) },
        }
      : { type: "disabled" }

    parent = await storage.executions.create({
      id: sourceExecutionId,
      requesterGroupIds: input.requesterGroupIds ?? [],
      projectId: input.projectId,
      ...(requestedBy ? { requestedBy } : {}),
      executor: { type: "request", requestId: `test_request:${input.runId}` },
      source: { type: "http", requestId: `test_request:${input.runId}` },
      correlationId: `test_correlation:${input.runId}`,
      authorizationRef,
    })
  }
  await storage.executions.create({
    id: executionId,
    requesterGroupIds: parent.requesterGroupIds,
    projectId: input.projectId,
    executor: { type: "agent", runId: input.runId },
    source: { type: "execution", executionId: sourceExecutionId },
    ...(parent.requestedBy === undefined
      ? {}
      : { requestedBy: structuredClone(parent.requestedBy) }),
    correlationId: parent.correlationId,
    authorizationRef:
      authority === "inherited"
        ? structuredClone(parent.authorizationRef)
        : {
            type: "principal",
            principal: { type: "serviceAccount", id: serviceAccountId! },
          },
  })
  return executionId
}

/** The user and a session of theirs, created once, that a signed-in request's execution names. */
async function ensureTestSession(
  storage: { readonly auth?: AuthStorage },
  input: { readonly projectId: string },
  user: UserPrincipal
): Promise<string> {
  const auth = storage.auth
  if (!auth) throw new Error("Requested Agent execution fixtures require auth storage.")

  const projectId = input.projectId
  if (!(await auth.users.getById({ projectId, id: user.id }))) {
    await auth.users.create({ projectId, id: user.id, email: `${user.id}@example.com` })
  }

  const id = `test_session:${user.id}`
  if (!(await auth.sessions.getById({ projectId, id }))) {
    const now = new Date()
    await auth.sessions.create({
      id,
      projectId,
      userId: user.id,
      strategyId: "test",
      tokenHash: id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
    })
  }
  return id
}
