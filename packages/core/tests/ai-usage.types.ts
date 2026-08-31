import type { AgentRunView, WorkflowAgentNodeRunView } from "@sixb/core"
import type {
  AgentRunRecord,
  AiModelCallUsageRecord,
  AiUsageExecutionSummary,
  AiUsageStorage,
  ReadonlyJsonObject,
  RecordAiModelCallInput,
  RecordAiModelCallResult,
  WorkflowAgentNodeRunRecord,
} from "@sixb/core/storage"

const rawUsage: ReadonlyJsonObject = { provider_counter: 1 }
const emptySummary: AiUsageExecutionSummary = {
  modelCallCount: 0,
  usage: { reportingStatus: "unavailable" },
}

const input: RecordAiModelCallInput = {
  id: "usage_1",
  projectId: "project_1",
  executionId: "exec_1",
  attempt: 1,
  callId: "call_1",
  requesterGroupIds: ["support"],
  providerId: "gateway",
  requestedModelId: "openai/gpt-5",
  responseId: "response_1",
  usage: { inputTokens: 10, outputTokens: 2 },
  rawUsage,
  occurredAt: new Date("2026-06-23T10:00:00.000Z"),
}

const provider = {
  async recordModelCall(recordInput: RecordAiModelCallInput): Promise<RecordAiModelCallResult> {
    const record: AiModelCallUsageRecord = {
      ...recordInput,
      usage: {
        ...recordInput.usage,
        totalTokens: 12,
        reportingStatus: "complete",
      },
      recordedAt: new Date("2026-06-23T10:00:01.000Z"),
    }
    return { record, created: true }
  },
  async getLatestForExecution() {
    return null
  },
  async summarizeExecution() {
    return emptySummary
  },
  async summarizeExecutions({ executionIds }) {
    return executionIds.map(() => emptySummary)
  },
} satisfies AiUsageStorage

declare const agentRun: AgentRunRecord
declare const agentRunView: AgentRunView
declare const workflowAgentNode: WorkflowAgentNodeRunRecord
declare const workflowAgentNodeView: WorkflowAgentNodeRunView

// Run rows must never grow a second accounting authority beside the model-call ledger.
// @ts-expect-error usage exists only through AiUsageStorage
agentRun.usage
// @ts-expect-error usage exists only through AiUsageStorage
workflowAgentNode.usage

// Runtime views may expose the ledger-derived summary without mutating storage records.
agentRunView.usage
workflowAgentNodeView.usage
// @ts-expect-error execution ownership stays private to the storage contract
workflowAgentNodeView.execution

void input
void provider
