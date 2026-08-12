import type { AuthorizationContext } from "../authorization"
import type { OntologySource } from "../ontology"
import { isBoundSixb, type Sixb } from "../runtime/sixb"
import { createAgentScope } from "./scopes"
import type { AuthorizablePrincipal, ExecutionScope, ExecutionSource } from "./types"

/** Minimal host boundary required by agent workers. */
export interface AgentExecutionHost {
  readonly id: string
  withScope(scope: ExecutionScope): object
}

export interface BindAgentExecutionInput {
  readonly agentId: string
  readonly runId: string
  readonly authorization: AuthorizationContext
  readonly source: ExecutionSource
  readonly requestedBy?: AuthorizablePrincipal
  readonly correlationId?: string
  readonly parentExecutionId?: string
}

/** Bind one agent service account's resolved grants to the claimed run. */
export function bindAgentExecution(
  host: AgentExecutionHost,
  input: BindAgentExecutionInput
): Sixb<readonly OntologySource[]> {
  const scope = createAgentScope({
    projectId: host.id,
    agentId: input.agentId,
    runId: input.runId,
    context: input.authorization,
    source: input.source,
    ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: input.parentExecutionId }),
  })
  const sixb = host.withScope(scope)
  if (!isBoundSixb(sixb)) {
    throw new Error("[Sixb] Agent execution host returned an invalid bound SDK.")
  }
  return sixb
}
