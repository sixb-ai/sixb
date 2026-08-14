import type {
  AiModelCallUsageRecord,
  AiUsageExecutionSummary,
  AiUsageStorage,
  Principal,
  ReadonlyJsonObject,
  RecordAiModelCallInput,
  RecordAiModelCallResult,
} from "@sixb/core/storage"

const requesterPrincipal: Principal = { type: "user", id: "usr_1" }
const rawUsage: ReadonlyJsonObject = { provider_counter: 1 }
const emptySummary: AiUsageExecutionSummary = {
  modelCallCount: 0,
  usage: { reportingStatus: "unavailable" },
}

const input: RecordAiModelCallInput = {
  id: "usage_1",
  projectId: "project_1",
  execution: { kind: "agentRun", runId: "run_1" },
  attempt: 1,
  callId: "call_1",
  requesterPrincipal,
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
  async summarizeExecution() {
    return emptySummary
  },
  async summarizeExecutions({ executions }) {
    return executions.map(() => emptySummary)
  },
} satisfies AiUsageStorage

void input
void provider
