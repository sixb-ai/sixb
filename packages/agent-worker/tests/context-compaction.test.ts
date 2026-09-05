import { describe, expect, test } from "bun:test"
import { defineAgent, InMemoryStorage, type Storage } from "@sixb/core"
import {
  estimateAgentContextMessagesTokens,
  estimateAgentContextRequestTokens,
  projectAgentThreadModelContext,
} from "@sixb/core/internal/agents"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { estimateAgentConversationInputTokens } from "../src/context-compaction"
import type { AgentWorkerStorage } from "../src/types"
import { WorkerTestModel } from "./worker-model-fixture"

const projectId = "context-compaction-tests"
const threadId = "thread"

function requireWorkerStorage(storage: Storage): AgentWorkerStorage {
  if (!storage.agents || !storage.auth || !storage.aiUsage) {
    throw new Error("Expected complete Agent worker storage.")
  }
  return storage as AgentWorkerStorage
}

describe("agent conversation context estimation", () => {
  test("anchors to the latest compatible provider call and estimates only trailing messages", async () => {
    const storage = new InMemoryStorage()
    const agents = storage.agents
    await agents.threads.create({
      id: threadId,
      projectId,
      agentId: "assistant",
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
      agentId: "assistant",
      runId: "run_1",
    })
    await agents.runs.create({
      id: "run_1",
      projectId,
      executionId,
      threadId,
      agentId: "assistant",
      triggerMessageId: user.id,
      requesterGroupIds: [],
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
    const agent = defineAgent("assistant", {
      name: "Assistant",
      model,
      instructions: "Answer clearly.",
    })
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
    const estimate = await estimateAgentConversationInputTokens({
      context: { id: projectId, storage: requireWorkerStorage(storage) },
      agent,
      threadContext: { checkpoint: null, retainedMessages: messages, modelMessages: messages },
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
    await expect(
      estimateAgentConversationInputTokens({
        context: { id: projectId, storage: requireWorkerStorage(storage) },
        agent,
        threadContext: { checkpoint: null, retainedMessages: messages, modelMessages: messages },
        systemPrompt: expandedSystemPrompt,
        tools: [],
      })
    ).resolves.toBe(expandedFullEstimate)

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
    await expect(
      estimateAgentConversationInputTokens({
        context: { id: projectId, storage: requireWorkerStorage(storage) },
        agent,
        threadContext: {
          checkpoint,
          retainedMessages: retainedAfterCheckpoint,
          modelMessages,
        },
        systemPrompt: "System",
        tools: [],
      })
    ).resolves.toBe(fallback)
  })

  test("falls back to the full request when the latest provider usage reports zero tokens", async () => {
    const storage = new InMemoryStorage()
    const agents = storage.agents
    await agents.threads.create({
      id: threadId,
      projectId,
      agentId: "assistant",
      ownerPrincipal: { type: "user", id: "user" },
    })
    const user = await agents.messages.append({
      id: "fallback_user",
      projectId,
      threadId,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "Question" }],
    })
    const executionId = await createTestAgentExecution(storage, {
      projectId,
      agentId: "assistant",
      runId: "fallback_run",
    })
    await agents.runs.create({
      id: "fallback_run",
      projectId,
      executionId,
      threadId,
      agentId: "assistant",
      triggerMessageId: user.id,
      requesterGroupIds: [],
    })
    await agents.runs.start({
      id: "fallback_run",
      projectId,
      execution: {
        token: "fallback_execution",
        queueLeaseExpiresAt: new Date("2026-08-27T12:05:00.000Z"),
      },
    })
    const assistant = await agents.messages.append({
      id: "fallback_assistant",
      projectId,
      threadId,
      runId: "fallback_run",
      role: "assistant",
      parts: [{ type: "text", text: "Answer" }],
    })

    const model = new WorkerTestModel({ modelId: "mock-model" })
    const agent = defineAgent("assistant", {
      name: "Assistant",
      model,
      instructions: "Answer clearly.",
    })
    await storage.aiUsage.recordModelCall({
      id: "usage_zero",
      projectId,
      executionId,
      attempt: 1,
      callId: "call_zero",
      requesterGroupIds: [],
      providerId: model.providerId,
      requestedModelId: model.modelId,
      responseId: "response_zero",
      usage: { inputTokens: 0, outputTokens: 0 },
      occurredAt: new Date("2026-08-27T12:01:00.000Z"),
    })

    const messages = [user, assistant]
    const expected = estimateAgentContextRequestTokens({
      systemPrompt: "System",
      tools: [],
      messages,
    }).tokens
    await expect(
      estimateAgentConversationInputTokens({
        context: { id: projectId, storage: requireWorkerStorage(storage) },
        agent,
        threadContext: { checkpoint: null, retainedMessages: messages, modelMessages: messages },
        systemPrompt: "System",
        tools: [],
      })
    ).resolves.toBe(expected)
  })
})
