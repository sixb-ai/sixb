import { expect, test } from "bun:test"
import { InMemoryBlobStorage, InMemoryStorage, type Storage } from "@sixb/core"
import type { AgentRunSessionHost } from "@sixb/core/internal/agents"
import { toModelMessages } from "@sixb/core/internal/agents"
import type { ModelMessage, ModelUsage } from "@sixb/core/models"
import type { ConversationAgentRunRecord } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { renderCurrentTime, renderWorkspaceMovedTag } from "../src/agent-prompt"
import { runTurnInSession } from "./helpers"
import { testStream, WorkerTestModel } from "./worker-model-fixture"

const projectId = "project"
const threadId = "thread"
const summary = "The user said one and the assistant answered two."
const serializedSummary = [
  "The earlier conversation was compacted into this continuation summary. Its messages are still stored: `sixb history` prints them.",
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

function requireWorkerStorage(storage: Storage): AgentRunSessionHost["storage"] {
  if (!storage.agents || !storage.auth || !storage.aiUsage) {
    throw new Error("Expected complete agent worker storage.")
  }
  return storage as AgentRunSessionHost["storage"]
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
  let prompt: readonly ModelMessage[] | undefined
  const model = captureModel((value) => {
    prompt = value
  })
  const plan = {
    instructions: "Answer clearly.",
    model,
    recordedModel: model,
    tools: [],
    skills: [],
    ontologyDocs: { files: [], index: [] },
  }

  await runTurnInSession({
    storage: requireWorkerStorage(seeded.storage),
    context: {
      id: projectId,
      authorPrincipal: { type: "serviceAccount", id: "service_agent" },
      blobStorage: new InMemoryBlobStorage(),
      tools: [],
      systemPrompt: "Test system prompt.",
      projectTimeZone: "UTC",
      projectLocale: "en",
    },
    plan,
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

  expect(conversationMessages(prompt)).toEqual(
    toModelMessages(transcript, {
      userMessageSuffix: (message) =>
        message.role === "user"
          ? renderCurrentTime(message.createdAt, { timeZone: "UTC", locale: "en" })
          : undefined,
    })
  )
})

test("a seeded checkpoint changes only the model input", async () => {
  // Verified regression guard: temporarily passing `retainedMessages` instead of `modelMessages`
  // from runAgentTurn removes the synthetic summary and makes this exact assertion fail.
  const { storage, prompt, transcript } = await runAndCaptureModelPrompt(true)
  const three = transcript.at(-1)
  if (!three) throw new Error("Expected the retained message.")

  // The synthetic summary is not a sent message, so only the retained one is dated.
  expect(conversationMessages(prompt)).toEqual([
    { role: "user", content: [{ type: "text", text: serializedSummary }] },
    {
      role: "user",
      content: [
        { type: "text", text: "three" },
        {
          type: "text",
          text: `\n\n${renderCurrentTime(three.createdAt, { timeZone: "UTC", locale: "en" })}`,
        },
      ],
    },
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

test("preserves exact prompt-cache prefixes across Cloud -> Computer -> Cloud -> Computer moves", async () => {
  // Guard proof: put workspaceMovedAt back in the system prompt, or omit movedMessageIds from
  // readAgentTurnHistory / conversationModelMessages; returning to a workspace rewrites its system
  // prompt and loses the cached conversation prefix, or drops the transition marker.
  const storage = new InMemoryStorage()
  const agents = storage.agents
  const laptopA = { id: "cmp_1", name: "MacBook", folder: "/Users/ava/app" }
  const laptopB = { id: "cmp_1", name: "MacBook", folder: "/Users/ava/docs" }

  await agents.threads.create({
    id: threadId,
    projectId,
    ownerPrincipal: { type: "user", id: "user" },
  })

  const captured: { readonly system: string; readonly messages: ModelMessage[] }[] = []
  const runTurn = async (input: {
    readonly index: number
    readonly text: string
    readonly systemPrompt: string
    readonly runsOn?: "computer"
    readonly computer?: { readonly id: string; readonly folder: string }
    readonly at: string
  }) => {
    const messageId = `msg_u_${input.index}`
    const runId = `run_${input.index}`
    const token = `tok_${input.index}`
    const createdAt = new Date(input.at)
    await agents.messages.append({
      id: messageId,
      projectId,
      threadId,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: input.text }],
      createdAt,
    })
    const executionId = await createTestAgentExecution(storage, { projectId, runId })
    await agents.runs.create({
      id: runId,
      projectId,
      executionId,
      threadId,
      triggerMessageId: messageId,
      createdAt,
      spec: {
        model: { provider: "test", modelId: "test-model" },
        ...(input.runsOn
          ? { runsOn: input.runsOn, ...(input.computer ? { computer: input.computer } : {}) }
          : {}),
      },
    })
    const started = await agents.runs.start({
      id: runId,
      projectId,
      startedAt: createdAt,
      execution: {
        token,
        queueLeaseExpiresAt: new Date(createdAt.getTime() + 300_000),
      },
      ...(input.computer ? { onComputer: input.computer } : {}),
    })
    if (started.kind !== "conversation") throw new Error("Expected conversation run.")

    const model = captureModel((prompt) => {
      const sys = prompt.find((m) => m.role === "system")
      captured.push({
        system: sys?.role === "system" ? sys.content : "",
        messages: prompt.filter((m) => m.role !== "system"),
      })
    })
    await runTurnInSession({
      storage: requireWorkerStorage(storage),
      context: {
        id: projectId,
        authorPrincipal: { type: "serviceAccount", id: "service_agent" },
        blobStorage: new InMemoryBlobStorage(),
        tools: [],
        systemPrompt: input.systemPrompt,
        projectTimeZone: "UTC",
        projectLocale: "en",
      },
      plan: {
        instructions: "Answer clearly.",
        model,
        recordedModel: model,
        tools: [],
        skills: [],
        ontologyDocs: { files: [], index: [] },
      },
      run: started,
      signal: new AbortController().signal,
    })
  }

  // Turn 1 in Cloud
  await runTurn({
    index: 1,
    text: "Inspect cloud objects",
    systemPrompt: "CLOUD_PROMPT",
    at: "2026-11-14T10:00:00.000Z",
  })

  // Move Cloud -> Laptop folder A, run Turn 2 & Turn 3
  await agents.threads.assignComputer({
    projectId,
    id: threadId,
    computer: laptopA,
    movedAt: new Date("2026-11-14T10:02:00.000Z"),
  })
  await runTurn({
    index: 2,
    text: "Edit local files",
    systemPrompt: "LAPTOP_A_PROMPT",
    runsOn: "computer",
    computer: { id: laptopA.id, folder: laptopA.folder },
    at: "2026-11-14T10:03:00.000Z",
  })
  await runTurn({
    index: 3,
    text: "Run local tests",
    systemPrompt: "LAPTOP_A_PROMPT",
    runsOn: "computer",
    computer: { id: laptopA.id, folder: laptopA.folder },
    at: "2026-11-14T10:04:00.000Z",
  })

  // Move Laptop folder A -> Cloud, run Turn 4
  await agents.threads.moveToCloud({
    projectId,
    id: threadId,
    movedAt: new Date("2026-11-14T10:05:00.000Z"),
  })
  await runTurn({
    index: 4,
    text: "Check live metrics in cloud",
    systemPrompt: "CLOUD_PROMPT",
    at: "2026-11-14T10:06:00.000Z",
  })

  // Move Cloud -> Laptop folder A again, run Turn 5
  await agents.threads.assignComputer({
    projectId,
    id: threadId,
    computer: laptopA,
    movedAt: new Date("2026-11-14T10:07:00.000Z"),
  })
  await runTurn({
    index: 5,
    text: "Back in app folder",
    systemPrompt: "LAPTOP_A_PROMPT",
    runsOn: "computer",
    computer: { id: laptopA.id, folder: laptopA.folder },
    at: "2026-11-14T10:08:00.000Z",
  })

  // Move Laptop folder A -> Laptop folder B, run Turn 6
  await agents.threads.assignComputer({
    projectId,
    id: threadId,
    computer: laptopB,
    movedAt: new Date("2026-11-14T10:09:00.000Z"),
  })
  await runTurn({
    index: 6,
    text: "Update docs folder",
    systemPrompt: "LAPTOP_B_PROMPT",
    runsOn: "computer",
    computer: { id: laptopB.id, folder: laptopB.folder },
    at: "2026-11-14T10:10:00.000Z",
  })

  const [c1, l2, l3, c4, l5, l6] = captured
  if (!c1 || !l2 || !l3 || !c4 || !l5 || !l6) throw new Error("Expected 6 captured prompts.")

  // 1. Consecutive turns in the same local folder share the exact prefix.
  expect(l3.system).toBe(l2.system)
  expect(l3.messages.slice(0, l2.messages.length)).toEqual(l2.messages)

  // 2. Returning to Cloud (Turn 4) matches Turn 1's system prompt and initial messages byte-for-byte!
  expect(c4.system).toBe(c1.system)
  expect(c4.messages.slice(0, c1.messages.length)).toEqual(c1.messages)

  // 3. Returning to Laptop folder A (Turn 5) matches Turn 3's system prompt and Turn 1..3 messages byte-for-byte!
  expect(l5.system).toBe(l3.system)
  expect(l5.messages.slice(0, l3.messages.length)).toEqual(l3.messages)

  // 4. Exactly the user messages after a move (Turn 2, Turn 4, Turn 5, Turn 6) carry <sixb_workspace_moved>,
  // while Turn 1 and Turn 3 (which stayed in place) do not.
  const userMessagesOf = (messages: readonly ModelMessage[]) =>
    messages
      .filter((m): m is Extract<ModelMessage, { role: "user" }> => m.role === "user")
      .map((m) => m.content.map((part) => (part.type === "text" ? part.text : "")).join(""))

  const finalUsers = userMessagesOf(l6.messages)
  expect(finalUsers).toHaveLength(6)
  expect(finalUsers[0]).not.toContain("<sixb_workspace_moved>")
  expect(finalUsers[1]).toContain(renderWorkspaceMovedTag())
  expect(finalUsers[2]).not.toContain("<sixb_workspace_moved>")
  expect(finalUsers[3]).toContain(renderWorkspaceMovedTag())
  expect(finalUsers[4]).toContain(renderWorkspaceMovedTag())
  expect(finalUsers[5]).toContain(renderWorkspaceMovedTag())
})
