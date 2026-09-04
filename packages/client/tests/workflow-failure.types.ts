import type {
  GetWorkflowAgentNodeExecutionResponses,
  GetWorkflowRunResponses,
  ListWorkflowRunsResponses,
  ListWorkflowsResponses,
} from "../src/generated/types.gen"

type LatestWorkflowRun = NonNullable<ListWorkflowsResponses[200][number]["latestRun"]>
type ListedWorkflowRun = ListWorkflowRunsResponses[200]["runs"][number]
type WorkflowNodeRun = GetWorkflowRunResponses[200]["nodes"][number]
type WorkflowAgentExecution = GetWorkflowAgentNodeExecutionResponses[200]

type LatestFailureCode = NonNullable<LatestWorkflowRun["error"]>["code"]
type ListedFailureCode = NonNullable<ListedWorkflowRun["error"]>["code"]
type NodeFailureCode = NonNullable<WorkflowNodeRun["error"]>["code"]
type AgentExecutionFailureCode = NonNullable<WorkflowAgentExecution["error"]>["code"]

const latestUnexpected: LatestFailureCode = "internal.unexpected"
const latestCancelled: LatestFailureCode = "runtime.cancelled"
const listedUnexpected: ListedFailureCode = "internal.unexpected"
const nodeCancelled: NodeFailureCode = "runtime.cancelled"
const agentExecutionCancelled: AgentExecutionFailureCode = "runtime.cancelled"
const latestNodeFailed: LatestFailureCode = "workflow.node_failed"
const nodeFailed: NodeFailureCode = "workflow.node_failed"
const workflowLimitExceeded: ListedFailureCode = "ai.usage_limit_exceeded"
const agentLimitUnavailable: AgentExecutionFailureCode = "ai.usage_limit_unavailable"

// Dataset lookup codes belong to HTTP route failures, not persisted workflow failures.
// @ts-expect-error the generated latest-run failure contract must stay scoped to its producer
const unrelatedLatest: LatestFailureCode = "dataset.not_found"
// @ts-expect-error the generated run-history failure contract must stay scoped to its producer
const unrelatedListed: ListedFailureCode = "dataset.not_found"
// @ts-expect-error the generated node-run failure contract must stay scoped to its producer
const unrelatedNode: NodeFailureCode = "dataset.not_found"
// @ts-expect-error workflow-owned agent executions keep the scoped agent-run failure contract
const unrelatedAgentExecution: AgentExecutionFailureCode = "dataset.not_found"

void [
  latestUnexpected,
  latestCancelled,
  listedUnexpected,
  nodeCancelled,
  agentExecutionCancelled,
  latestNodeFailed,
  nodeFailed,
  workflowLimitExceeded,
  agentLimitUnavailable,
  unrelatedLatest,
  unrelatedListed,
  unrelatedNode,
  unrelatedAgentExecution,
]
