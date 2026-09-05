import { expect, test } from "bun:test"
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider"
import { InMemoryBlobStorage, InMemoryStorage, type Storage } from "@sixb/core"
import { toModelMessages } from "@sixb/core/internal/agents"
import type { ConversationAgentRunRecord } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { runAgentTurn } from "../src/run-agent-turn"
import { NOOP_STREAM_SINK } from "../src/stream-sink"
import type { AgentWorkerStorage } from "../src/types"

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

const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
  raw: { input_tokens: 10, output_tokens: 7 },
}

function captureModel(
  capture: (prompt: LanguageModelV4CallOptions["prompt"]) => void
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async (options) => {
      capture(options.prompt)
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Done" },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ]
      return { stream: convertArrayToReadableStream(chunks) }
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
    runId: "run_1",
  })
  await agents.runs.create({
    id: "run_1",
    projectId,
    executionId: firstExecutionId,
    threadId,
    triggerMessageId: "message_1",
    spec: { model: { provider: "test", modelId: "test-model" } },
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
    runId: "run_2",
  })
  await agents.runs.create({
    id: "run_2",
    projectId,
    executionId: secondExecutionId,
    threadId,
    triggerMessageId: "message_3",
    spec: { model: { provider: "test", modelId: "test-model" } },
    requesterGroupIds: [],
  })
  const started = await agents.runs.start({
    id: "run_2",
    projectId,
    execution: {
      token: "execution_2",
      queueLeaseExpiresAt: new Date("2026-08-27T12:10:00.000Z"),
    },
  })
  if (started.kind !== "conversation") throw new Error("Expected a conversational Agent run.")
  const run: ConversationAgentRunRecord = started

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
  let prompt: LanguageModelV4CallOptions["prompt"] | undefined
  const plan = {
    instructions: "Answer clearly.",
    model: captureModel((value) => {
      prompt = value
    }),
    tools: [],
    maxSteps: 4,
  }

  await runAgentTurn({
    context: {
      id: projectId,
      authorPrincipal: { type: "serviceAccount", id: "service_agent" },
      storage: requireWorkerStorage(seeded.storage),
      blobStorage: new InMemoryBlobStorage(),
      tools: {},
      systemPrompt: "Test system prompt.",
      streamSink: NOOP_STREAM_SINK,
      recoverAiModelCall: async () => {},
      turnTimeoutMs: 60_000,
    },
    plan,
    run: seeded.run,
    signal: new AbortController().signal,
  })

  if (!prompt) throw new Error("Expected the model prompt to be captured.")
  return { ...seeded, prompt }
}

function conversationMessages(prompt: LanguageModelV4CallOptions["prompt"]): readonly unknown[] {
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
