import { expect, test } from "bun:test"
import { defineAgent, InMemoryBlobStorage, InMemoryStorage, type Storage } from "@sixb/core"
import { toModelMessages } from "@sixb/core/internal/agents"
import type { ModelMessage, ModelUsage } from "@sixb/core/models"
import { createTestAgentExecution } from "@sixb/core/testing"
import { runAgentTurn } from "../src/run-agent-turn"
import { NOOP_STREAM_SINK } from "../src/stream-sink"
import type { AgentWorkerStorage } from "../src/types"
import { testStream, WorkerTestModel } from "./worker-model-fixture"

const projectId = "project"
const threadId = "thread"
const summary = "The user said one and the assistant answered two."
const serializedSummary = [
  "The earlier conversation was compacted into this continuation summary.",
  "",
  "<sixb_thread_summary>",
  summary,
  "</sixb_thread_summary>",
].join("\n")

const usage: ModelUsage = {
  inputTokens: 10,
  outputTokens: 7,
  uncachedInputTokens: 10,
  cacheReadInputTokens: 0,
  raw: { input_tokens: 10, output_tokens: 7 },
}

function captureModel(capture: (prompt: readonly ModelMessage[]) => void): WorkerTestModel {
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
      capture(options.messages)
      return testStream([
        { type: "stream-start" },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Done" },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", usage },
      ])
    },
  })
}

function requireWorkerStorage(storage: Storage): AgentWorkerStorage {
  if (!storage.agents || !storage.auth || !storage.aiUsage) {
    throw new Error("Expected complete agent worker storage.")
  }
  return storage as AgentWorkerStorage
}

async function seedThread(withCheckpoint: boolean) {
  const storage = new InMemoryStorage()
  const agents = storage.agents
  await agents.threads.create({
    id: threadId,
    projectId,
    agentId: "assistant",
    ownerPrincipal: { type: "user", id: "user" },
  })
  await agents.messages.append({
    id: "message_1",
    projectId,
    threadId,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "one" }],
  })

  const firstExecutionId = await createTestAgentExecution(storage, {
    projectId,
    agentId: "assistant",
    runId: "run_1",
  })
  await agents.runs.create({
    id: "run_1",
    projectId,
    executionId: firstExecutionId,
    threadId,
    agentId: "assistant",
    triggerMessageId: "message_1",
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
  await agents.messages.append({
    id: "message_2",
    projectId,
    threadId,
    runId: "run_1",
    role: "assistant",
    parts: [{ type: "text", text: "two" }],
  })
  await agents.runs.finish({
    id: "run_1",
    projectId,
    executionToken: "execution_1",
    status: "succeeded",
  })

  await agents.messages.append({
    id: "message_3",
    projectId,
    threadId,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "three" }],
  })
  const secondExecutionId = await createTestAgentExecution(storage, {
    projectId,
    agentId: "assistant",
    runId: "run_2",
  })
  await agents.runs.create({
    id: "run_2",
    projectId,
    executionId: secondExecutionId,
    threadId,
    agentId: "assistant",
    triggerMessageId: "message_3",
    requesterGroupIds: [],
  })
  const run = await agents.runs.start({
    id: "run_2",
    projectId,
    execution: {
      token: "execution_2",
      queueLeaseExpiresAt: new Date("2026-08-27T12:10:00.000Z"),
    },
  })

  if (withCheckpoint) {
    await agents.checkpoints.create({
      id: "checkpoint_1",
      projectId,
      threadId,
      createdByRunId: "run_2",
      expectedPreviousCheckpointId: null,
      expectedHeadSeq: 3,
      executionToken: "execution_2",
      reason: "threshold",
      summary,
      summaryFormatVersion: 1,
      summarizedThroughSeq: 2,
      observedHeadSeq: 3,
      estimatedInputTokensBefore: 1_000,
      estimatedInputTokensAfter: 300,
      summaryModelId: "test-model",
    })
  }

  const transcript = await agents.messages.list({ projectId, threadId, order: "asc" })
  return { storage, run, transcript: transcript.messages }
}

async function runAndCaptureModelPrompt(withCheckpoint: boolean) {
  const seeded = await seedThread(withCheckpoint)
  let prompt: readonly ModelMessage[] | undefined
  const agent = defineAgent("assistant", {
    name: "Assistant",
    instructions: "Answer clearly.",
    model: captureModel((value) => {
      prompt = value
    }),
  })

  await runAgentTurn({
    context: {
      id: projectId,
      agentPrincipal: { type: "serviceAccount", id: "service_agent" },
      storage: requireWorkerStorage(seeded.storage),
      blobStorage: new InMemoryBlobStorage(),
      tools: [],
      streamSink: NOOP_STREAM_SINK,
      recoverAiModelCall: async () => {},
      defaultMaxSteps: 4,
      turnTimeoutMs: 60_000,
    },
    agent,
    run: seeded.run,
    signal: new AbortController().signal,
  })

  if (!prompt) throw new Error("Expected the model prompt to be captured.")
  return { ...seeded, prompt }
}

function conversationMessages(prompt: readonly ModelMessage[]): readonly unknown[] {
  return prompt.filter((message) => message.role !== "system")
}

test("preserves the exact model history when no checkpoint exists", async () => {
  const { prompt, transcript } = await runAndCaptureModelPrompt(false)

  expect(conversationMessages(prompt)).toEqual(toModelMessages(transcript))
})

test("a seeded checkpoint changes only the model input", async () => {
  // Verified regression guard: temporarily passing `retainedMessages` instead of `modelMessages`
  // from runAgentTurn removes the synthetic summary and makes this exact assertion fail.
  const { storage, prompt, transcript } = await runAndCaptureModelPrompt(true)

  expect(conversationMessages(prompt)).toEqual([
    { role: "user", content: [{ type: "text", text: serializedSummary }] },
    { role: "user", content: [{ type: "text", text: "three" }] },
  ])

  const durableTranscript = await storage.agents.messages.list({
    projectId,
    threadId,
    order: "asc",
  })
  const originalMessages: readonly unknown[] = durableTranscript.messages.slice(
    0,
    transcript.length
  )
  expect(originalMessages).toEqual(transcript)
})
