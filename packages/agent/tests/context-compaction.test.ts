import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "@sixb/core"
import {
  estimateAgentContextMessagesTokens,
  estimateAgentContextRequestTokens,
  projectAgentThreadModelContext,
} from "@sixb/core/internal/agents"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { prepareAgentModel } from "../src/context-budget"
import { estimateAgentConversation } from "../src/context-compaction"
import { agentThreadModelContext } from "../src/thread-context"
import { WorkerTestModel } from "./worker-model-fixture"

const projectId = "context-compaction-tests"
const threadId = "thread"

describe("agent conversation context estimation", () => {
  test("anchors to the latest provider call with usage and estimates only trailing messages", async () => {
    const storage = new InMemoryStorage()
    const agents = storage.agents
    await agents.threads.create({
      id: threadId,
      projectId,
      ownerPrincipal: { type: "user", id: "user" },
    })
    const user = await agents.messages.append({
      id: "message_1",
      projectId,
      threadId,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "First question" }],
    })
    const executionId = await createTestAgentExecution(storage, {
      projectId,
      runId: "run_1",
    })
    await agents.runs.create({
      id: "run_1",
      projectId,
      executionId,
      threadId,
      triggerMessageId: user.id,
      spec: { model: { provider: "test", modelId: "test-model" } },
    })
    await agents.runs.start({
      id: "run_1",
      projectId,
      execution: {
        token: "execution_1",
        queueLeaseExpiresAt: new Date("2026-08-27T12:05:00.000Z"),
      },
    })
    const assistant = await agents.messages.append({
      id: "message_2",
      projectId,
      threadId,
      runId: "run_1",
      role: "assistant",
      parts: [{ type: "text", text: "First answer" }],
    })
    await agents.runs.finish({
      id: "run_1",
      projectId,
      executionToken: "execution_1",
      status: "succeeded",
    })
    const trailing = await agents.messages.append({
      id: "message_3",
      projectId,
      threadId,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "Follow-up question with new details" }],
    })

    const model = new WorkerTestModel({ modelId: "mock-model" })
    const budget = prepareAgentModel({ model }).budget
    const { bytesPerToken } = budget
    const plan = {
      model,
      instructions: "Answer clearly.",
      tools: [],
      skills: [],
      ontologyDocs: { files: [], index: [] },
      maxSteps: 4,
    }
    await storage.aiUsage.recordModelCall({
      id: "usage_1",
      projectId,
      executionId,
      attempt: 1,
      callId: "call_1",
      requesterGroupIds: [],
      providerId: model.providerId,
      requestedModelId: model.modelId,
      responseId: "response_1",
      usage: { inputTokens: 1_000, outputTokens: 200 },
      occurredAt: new Date("2026-08-27T12:01:00.000Z"),
    })

    const messages: readonly AgentMessageRecord[] = [user, assistant, trailing]
    // The model call the session finds for the latest answer, as `AgentTurnHistory.usageAnchor`.
    const anchored = async () => {
      const modelCall = await storage.aiUsage.getLatestForExecution({ projectId, executionId })
      if (!modelCall) throw new Error("Expected the answer's model call.")
      return agentThreadModelContext({
        checkpoint: null,
        messages,
        sentTimeZones: {},
        usageAnchor: { messageId: assistant.id, modelCall },
      })
    }
    const estimate = estimateAgentConversation({
      plan,
      budget,
      threadContext: await anchored(),
      systemPrompt: "This full fallback prompt should not be counted.",
      tools: [],
    }).tokens

    expect(estimate).toBe(
      1_200 + estimateAgentContextMessagesTokens([trailing], bytesPerToken).tokens
    )

    // Regression proof: provider usage belongs to the historical request shape. New instructions
    // or skill/tool catalog content must still contribute to the next request's preflight size.
    const expandedSystemPrompt = `New deployment instructions:\n${"new requirement ".repeat(1_000)}`
    const expandedFullEstimate = estimateAgentContextRequestTokens({
      systemPrompt: expandedSystemPrompt,
      tools: [],
      messages,
      bytesPerToken,
    }).tokens
    expect(expandedFullEstimate).toBeGreaterThan(estimate)
    expect(
      estimateAgentConversation({
        plan,
        budget,
        threadContext: await anchored(),
        systemPrompt: expandedSystemPrompt,
        tools: [],
      }).tokens
    ).toBe(expandedFullEstimate)

    const retainedAfterCheckpoint: readonly AgentMessageRecord[] = [
      { ...user, id: "retained_user", seq: 3 },
      { ...assistant, id: "stale_assistant", seq: 4 },
      { ...trailing, id: "new_trigger", seq: 5 },
    ]
    const checkpoint = {
      id: "checkpoint_1",
      projectId,
      threadId,
      createdByRunId: "current_run",
      reason: "threshold" as const,
      summary: "Earlier context.",
      summaryFormatVersion: 1 as const,
      summarizedThroughSeq: 2,
      observedHeadSeq: 4,
      estimatedInputTokensBefore: 2_000,
      estimatedInputTokensAfter: 500,
      summaryModelId: model.modelId,
      createdAt: new Date("2026-08-27T12:02:00.000Z"),
    }
    const modelMessages = projectAgentThreadModelContext({
      checkpoint,
      messages: retainedAfterCheckpoint,
    })
    const fallback = estimateAgentContextRequestTokens({
      systemPrompt: "System",
      tools: [],
      messages: modelMessages,
      bytesPerToken,
    }).tokens
    expect(
      estimateAgentConversation({
        plan,
        budget,
        // The session found no anchor after the checkpoint's head.
        threadContext: agentThreadModelContext({
          checkpoint,
          messages: retainedAfterCheckpoint,
          sentTimeZones: {},
        }),
        systemPrompt: "System",
        tools: [],
      }).tokens
    ).toBe(fallback)

    // A provider call that reports no output or no input tokens is no anchor, however large the
    // other count: the full request is estimated. Regression proof: drop `outputTokens > 0` or
    // `inputTokens > 0` from the anchor guard.
    const empty = [
      { inputTokens: 1_000_000, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 1_000_000 },
    ]
    for (const [index, usage] of empty.entries()) {
      await storage.aiUsage.recordModelCall({
        id: `usage_zero_${index}`,
        projectId,
        executionId,
        attempt: 1,
        callId: `call_zero_${index}`,
        requesterGroupIds: [],
        providerId: model.providerId,
        requestedModelId: model.modelId,
        responseId: `response_zero_${index}`,
        usage,
        occurredAt: new Date(`2026-08-27T12:0${3 + index}:00.000Z`),
      })
      expect(
        estimateAgentConversation({
          plan,
          budget,
          threadContext: await anchored(),
          systemPrompt: "System",
          tools: [],
        }).tokens
      ).toBe(
        estimateAgentContextRequestTokens({
          systemPrompt: "System",
          tools: [],
          messages,
          bytesPerToken,
        }).tokens
      )
    }
  })
})

describe("agent conversation token rate", () => {
  const record = (
    id: string,
    role: AgentMessageRecord["role"],
    parts: AgentMessageRecord["parts"],
    seq: number
  ): AgentMessageRecord => ({
    id,
    projectId,
    threadId,
    runId: role === "assistant" ? "run_1" : null,
    role,
    seq,
    parts,
    contentVersion: 1,
    createdAt: new Date("2026-08-27T12:00:00.000Z"),
  })
  const model = new WorkerTestModel({ modelId: "anthropic/claude-haiku-5.5" })
  const plan = {
    model,
    instructions: "Answer clearly.",
    tools: [],
    skills: [],
    ontologyDocs: { files: [], index: [] },
    maxSteps: 4,
  }
  // The rate the project's runs measured on the model lately.
  const budget = prepareAgentModel({
    model,
    tokenRates: [{ bytes: 21_000, tokens: 10_000 }],
  }).budget
  // 30,000 bytes sent before the answer's last step; that step's text is the call's output.
  const user = record("user", "user", [{ type: "text", text: "a".repeat(20_000) }], 1)
  const answer = record(
    "answer",
    "assistant",
    [
      { type: "step-start" },
      { type: "text", text: "b".repeat(10_000) },
      { type: "step-start" },
      { type: "text", text: "c".repeat(50_000) },
    ],
    2
  )
  const context = (usage: { providerId?: string; inputTokens: number }) =>
    agentThreadModelContext({
      checkpoint: null,
      messages: [user, answer, record("next", "user", [{ type: "text", text: "Next" }], 3)],
      sentTimeZones: {},
      usageAnchor: {
        messageId: answer.id,
        modelCall: {
          id: "usage",
          projectId,
          executionId: "execution",
          attempt: 1,
          callId: "call",
          requesterGroupIds: [],
          providerId: usage.providerId ?? model.providerId,
          requestedModelId: model.modelId,
          responseId: "response",
          usage: { inputTokens: usage.inputTokens, outputTokens: 500, reportingStatus: "complete" },
          occurredAt: new Date("2026-08-27T12:01:00.000Z"),
          recordedAt: new Date("2026-08-27T12:01:00.000Z"),
        },
      },
    })
  const rate = (usage: Parameters<typeof context>[0]) =>
    estimateAgentConversation({
      plan,
      budget,
      threadContext: context(usage),
      systemPrompt: "",
      tools: [],
    }).bytesPerToken

  test("starts from the rate its run starts from", () => {
    expect(budget.bytesPerToken).toBe(2.1)
    expect(rate({ providerId: "other", inputTokens: 12_526 })).toBe(2.1)
  })

  // Removal proof: measure the whole anchored answer, last step included; the 50,000 bytes the
  // call wrote count as input it read, and the rate comes out at 6.4 bytes per token, clamped to
  // 2.625.
  test("measures the rate on what the anchored call read", () => {
    // 30,000 bytes over 12,500 text tokens: the provider's count less 8 + 2 × 8 + 2 overhead.
    expect(rate({ inputTokens: 12_526 })).toBe(2.4)
  })
})
