import type { Principal } from "@sixb/core"
import { resolveAuthorizationContext } from "@sixb/core"
import { bindAgentExecution } from "@sixb/core/internal/agent-execution"
import type { AgentExecutionIdentity } from "./identity"
import type { AgentExecutionContext, AgentWorkerContext, AgentWorkerHost } from "./types"

export function createAgentExecutionContext(input: {
  readonly context: AgentWorkerContext
  readonly host: AgentWorkerHost
  readonly identity: AgentExecutionIdentity
  readonly agentId: string
  readonly runId: string
  readonly queueJobId: string
  readonly requestedBy?: Principal
}): AgentExecutionContext {
  const authorization = resolveAuthorizationContext({
    principal: input.identity.principal,
    groupIds: input.identity.groupMemberships.map((membership) => membership.groupId),
    roles: input.host.security.listResolvedRoles(),
  })
  const requestedBy = authorizablePrincipal(input.requestedBy)
  const execution = bindAgentExecution(input.host, {
    agentId: input.agentId,
    runId: input.runId,
    authorization,
    source: { type: "queue", queue: "agents", jobId: input.queueJobId },
    ...(requestedBy === undefined ? {} : { requestedBy }),
  })

  return {
    ...input.context,
    blobStorage: execution.blobs,
    connector: execution.connector,
  }
}

function authorizablePrincipal(
  principal: Principal | undefined
): Extract<Principal, { readonly type: "user" | "serviceAccount" }> | undefined {
  return principal?.type === "user" || principal?.type === "serviceAccount" ? principal : undefined
}
