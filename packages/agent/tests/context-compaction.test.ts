import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "@sixb/core"
import {
  estimateAgentContextMessagesTokens,
  estimateAgentContextRequestTokens,
  projectAgentThreadModelContext,
} from "@sixb/core/internal/agents"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { estimateAgentConversationInputTokens } from "../src/context-compaction"
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
    const plan = {
      model,
      instructions: "Answer clearly.",
      tools: [],
      skills: [],
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
    const estimate = estimateAgentConversationInputTokens({
      plan,
      threadContext: await anchored(),
      systemPrompt: "This full fallback prompt should not be counted.",
      tools: [],
    })

    expect(estimate).toBe(1_200 + estimateAgentContextMessagesTokens([trailing]).tokens)

    // Regression proof: provider usage belongs to the historical request shape. New instructions
    // or skill/tool catalog content must still contribute to the next request's preflight size.
    const expandedSystemPrompt = `New deployment instructions:\n${"new requirement ".repeat(1_000)}`
    const expandedFullEstimate = estimateAgentContextRequestTokens({
      systemPrompt: expandedSystemPrompt,
      tools: [],
      messages,
    }).tokens
    expect(expandedFullEstimate).toBeGreaterThan(estimate)
    expect(
      estimateAgentConversationInputTokens({
        plan,
        threadContext: await anchored(),
        systemPrompt: expandedSystemPrompt,
        tools: [],
      })
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
    }).tokens
    expect(
      estimateAgentConversationInputTokens({
        plan,
        // The session found no anchor after the checkpoint's head.
        threadContext: agentThreadModelContext({
          checkpoint,
          messages: retainedAfterCheckpoint,
          sentTimeZones: {},
        }),
        systemPrompt: "System",
        tools: [],
      })
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
        estimateAgentConversationInputTokens({
          plan,
          threadContext: await anchored(),
          systemPrompt: "System",
          tools: [],
        })
      ).toBe(
        estimateAgentContextRequestTokens({ systemPrompt: "System", tools: [], messages }).tokens
      )
    }
  })
})
