import type { GetAgentRunResponses, ListAgentThreadRunsResponses } from "../src/generated/types.gen"

type AgentRun = GetAgentRunResponses[200]
type ListedAgentRun = ListAgentThreadRunsResponses[200]["runs"][number]

type AgentRunFailureCode = NonNullable<AgentRun["error"]>["code"]
type ListedAgentRunFailureCode = NonNullable<ListedAgentRun["error"]>["code"]

const unexpected: AgentRunFailureCode = "internal.unexpected"
const cancelled: AgentRunFailureCode = "runtime.cancelled"
const executionFailed: AgentRunFailureCode = "agent.execution_failed"
const listedUnexpected: ListedAgentRunFailureCode = "internal.unexpected"
const listedExecutionFailed: ListedAgentRunFailureCode = "agent.execution_failed"
const limitExceeded: AgentRunFailureCode = "ai.usage_limit_exceeded"
const listedLimitUnavailable: ListedAgentRunFailureCode = "ai.usage_limit_unavailable"

// Dataset lookup codes belong to HTTP route failures, not persisted agent-run failures.
// @ts-expect-error the generated agent-run failure contract must stay scoped to its producer
const unrelatedRun: AgentRunFailureCode = "dataset.not_found"
// @ts-expect-error the generated agent history contract must stay scoped to its producer
const unrelatedListed: ListedAgentRunFailureCode = "dataset.not_found"

void [
  unexpected,
  cancelled,
  executionFailed,
  listedUnexpected,
  listedExecutionFailed,
  limitExceeded,
  listedLimitUnavailable,
  unrelatedRun,
  unrelatedListed,
]
