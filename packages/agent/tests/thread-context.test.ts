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

// ── Moves and the prompt cache ────────────────────────────────────────────────────────────────
//
// Each workspace caches the prompt its turns sent. A conversation that comes back to one reads that
// cache again only if every later request there starts with the exact bytes of the earlier ones.
// These scenarios drive turns through the session as a runner does and compare the history the
// model received, `<sixb_workspace_moved>` notes included. The system prompt here is the test's
// own: the worker's "a conversation back in a workspace sends the prompt that workspace sent
// before" checks the one a turn builds.

/** Where a turn runs: the cloud, or a folder of its owner's computer. */
type Workspace = "cloud" | { readonly id: string; readonly folder: string }

const OWNER = { type: "user", id: "user" } as const

const APP_FOLDER: Workspace = { id: "cmp_1", folder: "/Users/ava/app" }
const DOCS_FOLDER: Workspace = { id: "cmp_1", folder: "/Users/ava/docs" }
const SITE_FOLDER: Workspace = { id: "cmp_1", folder: "/Users/ava/site" }

function workspaceKey(workspace: Workspace): string {
  return workspace === "cloud" ? "cloud" : `${workspace.id}:${workspace.folder}`
}

interface TurnOptions {
  readonly fails?: boolean
  /**
   * Compact within the turn, before its model call: the summary ends before its message, or before
   * the last message sent into an earlier turn, which it keeps.
   */
  readonly compacts?: "before its message" | "before the last steer"
}

/** One request a turn sent its model. */
interface SentRequest {
  /** The text of the user message the turn answers. */
  readonly turn: string
  readonly workspace: Workspace
  /** A compaction replaces what came before it: requests on either side share no prefix. */
  readonly checkpointId: string | undefined
  /** An attempt that failed, which a retry runs again. */
  readonly failed: boolean
  /** Everything but the system prompt. */
  readonly messages: readonly ModelMessage[]
}

/** A conversation's turns, its moves, and every request its model received. */
class MovingConversation {
  readonly requests: SentRequest[] = []
  private workspace: Workspace = "cloud"
  private userMessages = 0
  private lastSteerId: string | undefined

  private constructor(
    private readonly storage: InMemoryStorage,
    readonly threadId: string,
    /** Each user message's text is this prefix and its number. */
    private readonly label: string,
    private readonly now: () => Date
  ) {}

  /** A conversation started in `workspace`: in the cloud, or by `sixb` in a folder. */
  static async start(workspace: Workspace = "cloud"): Promise<MovingConversation> {
    const storage = new InMemoryStorage()
    let minute = 0
    const now = () => new Date(Date.UTC(2026, 10, 14, 10, minute++))

    await storage.agents.threads.create({
      id: threadId,
      projectId,
      ownerPrincipal: { type: "user", id: "user" },
      ...(workspace === "cloud"
        ? {}
        : { runsOn: "computer" as const, computer: { ...workspace, name: "MacBook" } }),
      createdAt: now(),
    })
    const conversation = new MovingConversation(storage, threadId, "U", now)
    conversation.workspace = workspace
    return conversation
  }

  async moveTo(workspace: Workspace): Promise<void> {
    const threads = this.storage.agents.threads
    if (workspace === "cloud") {
      await threads.moveToCloud({ projectId, id: this.threadId, movedAt: this.now() })
    } else {
      await threads.assignComputer({
        projectId,
        id: this.threadId,
        computer: { ...workspace, name: "MacBook" },
        movedAt: this.now(),
      })
    }
    this.workspace = workspace
  }

  /** Send a message and run its turn where the conversation is. */
  async turn(options: TurnOptions = {}) {
    const runId = await this.queue()
    return this.run(runId, options)
  }

  /** Send a message whose turn waits for its runner: a move may take it elsewhere. */
  async queue(): Promise<string> {
    this.userMessages += 1
    const messageId = `${this.threadId}_message_${this.userMessages}`
    await this.storage.agents.messages.append({
      id: messageId,
      projectId,
      threadId: this.threadId,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: `${this.label}${this.userMessages}` }],
      createdAt: this.now(),
    })
    return this.createRun(messageId, `${messageId}_run`)
  }

  /**
   * Send a message while a turn waits or runs, as the composer's steer does: it waits in the
   * thread's inbox, and the turn reads it and saves it, with no run of its own.
   */
  async steer(text: string): Promise<void> {
    const messageId = `${this.threadId}_steer_${this.userMessages}`
    await this.storage.agents.inbox.enqueue({
      id: `${messageId}_inbox`,
      projectId,
      threadId: this.threadId,
      messageId,
      authorPrincipal: OWNER,
      mode: "steer",
      parts: [{ type: "text", text }],
      createdAt: this.now(),
    })
    this.lastSteerId = messageId
  }

  /** Run a failed turn again, where the conversation is now, as a retry does. */
  async retry(failedRunId: string) {
    const failed = await this.storage.agents.runs.getById({ projectId, id: failedRunId })
    if (failed?.kind !== "conversation") throw new Error("Expected the failed turn's run.")

    await this.storage.agents.messages.deleteByRunId({
      projectId,
      threadId: this.threadId,
      runId: failed.id,
    })
    const runId = await this.createRun(failed.triggerMessageId, `${failed.id}_retry`)
    return this.run(runId)
  }

  async fork(): Promise<MovingConversation> {
    const id = `${this.threadId}_fork`
    await this.storage.agents.threads.fork({
      projectId,
      sourceThreadId: this.threadId,
      id,
      ownerPrincipal: { type: "user", id: "user" },
      createdAt: this.now(),
    })
    return new MovingConversation(this.storage, id, "F", this.now)
  }

  private async createRun(triggerMessageId: string, runId: string): Promise<string> {
    // Asked for by the conversation's owner: a turn reads only the steers its requester sent.
    const executionId = await createTestAgentExecution(this.storage, {
      projectId,
      runId,
      requestedBy: OWNER,
    })
    const computer = this.workspace === "cloud" ? undefined : this.workspace
    await this.storage.agents.runs.create({
      id: runId,
      projectId,
      executionId,
      threadId: this.threadId,
      triggerMessageId,
      createdAt: this.now(),
      spec: {
        model: { provider: "test", modelId: "test-model" },
        ...(computer ? { runsOn: "computer" as const, computer } : {}),
      },
    })
    return runId
  }

  /** Start a turn where its run says it runs, as that workspace's runner does, and send it. */
  async run(runId: string, options: TurnOptions = {}): Promise<SentRequest> {
    const agents = this.storage.agents
    const queued = await agents.runs.getById({ projectId, id: runId })
    if (queued?.kind !== "conversation") throw new Error("Expected a conversation run.")

    const workspace: Workspace = queued.spec?.computer ?? "cloud"
    const token = `${runId}_token`
    const startedAt = this.now()
    const started = await agents.runs.start({
      id: runId,
      projectId,
      startedAt,
      execution: { token, queueLeaseExpiresAt: new Date(startedAt.getTime() + 300_000) },
      ...(workspace === "cloud" ? {} : { onComputer: workspace }),
    })
    if (started.kind !== "conversation") throw new Error("Expected a conversation run.")

    if (options.compacts) await this.compact(started, token, options.compacts)
    const checkpoint = await agents.checkpoints.getLatest({ projectId, threadId: this.threadId })

    const trigger = await agents.messages.getById({ projectId, id: started.triggerMessageId })
    const firstPart = trigger?.parts[0]
    const turnText = firstPart?.type === "text" ? firstPart.text : runId

    let sent: readonly ModelMessage[] | undefined
    const model = new WorkerTestModel({
      modelId: "mock-model",
      stream: async (request) => {
        sent = request.messages.filter((message) => message.role !== "system")
        if (options.fails) throw new Error("[Test] The provider failed.")

        return testStream([
          { type: "stream-start" },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: `Answer to ${turnText}` },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: "stop", rawFinishReason: "stop", usage },
        ])
      },
    })

    const turnRun = runTurnInSession({
      storage: requireWorkerStorage(this.storage),
      context: {
        id: projectId,
        authorPrincipal: { type: "serviceAccount", id: "service_agent" },
        blobStorage: new InMemoryBlobStorage(),
        tools: [],
        systemPrompt: "Test system prompt.",
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
    if (options.fails) {
      await turnRun.catch((error) => error)
      await this.failIfRunning(runId, token)
    } else {
      await turnRun
    }

    if (!sent) throw new Error(`Expected ${turnText} to reach its model.`)
    const request: SentRequest = {
      turn: turnText,
      workspace,
      checkpointId: checkpoint?.id,
      failed: options.fails === true,
      messages: sent,
    }
    this.requests.push(request)
    return request
  }

  private async failIfRunning(runId: string, token: string): Promise<void> {
    const run = await this.storage.agents.runs.getById({ projectId, id: runId })
    if (run?.status !== "running") return

    await this.storage.agents.runs.finish({
      id: runId,
      projectId,
      executionToken: token,
      status: "failed",
    })
  }

  /**
   * Summarize the history as a compaction within the turn's run does: what came before its message,
   * or before the last steer, which a compaction may keep as it keeps any user message.
   */
  private async compact(
    run: ConversationAgentRunRecord,
    token: string,
    through: NonNullable<TurnOptions["compacts"]>
  ): Promise<void> {
    const agents = this.storage.agents
    const { messages } = await agents.messages.list({
      projectId,
      threadId: this.threadId,
      order: "asc",
    })
    const firstKept = messages.find(
      (message) =>
        message.id ===
        (through === "before the last steer" ? this.lastSteerId : run.triggerMessageId)
    )
    const head = messages.at(-1)
    if (!firstKept || !head) throw new Error("Expected the message the summary ends before.")

    const previous = await agents.checkpoints.getLatest({ projectId, threadId: this.threadId })
    await agents.checkpoints.create({
      id: `${run.id}_checkpoint`,
      projectId,
      threadId: this.threadId,
      createdByRunId: run.id,
      expectedPreviousCheckpointId: previous?.id ?? null,
      expectedHeadSeq: head.seq,
      executionToken: token,
      reason: "threshold",
      summary: `Everything before ${firstKept.id}.`,
      summaryFormatVersion: 1,
      summarizedThroughSeq: firstKept.seq - 1,
      observedHeadSeq: head.seq,
      estimatedInputTokensBefore: 1_000,
      estimatedInputTokensAfter: 300,
      summaryModelId: "test-model",
    })
  }
}

/**
 * Every request's history starts with the exact bytes of each earlier one sent from its workspace,
 * since the same compaction. A failed attempt is compared where its scenario says what holds.
 */
function expectEachWorkspaceReplaysItsRequests(requests: readonly SentRequest[]): void {
  const sent = requests.filter((request) => !request.failed)
  for (const [index, later] of sent.entries()) {
    for (const earlier of sent.slice(0, index)) {
      if (workspaceKey(earlier.workspace) !== workspaceKey(later.workspace)) continue
      if (earlier.checkpointId !== later.checkpointId) continue

      expectStartsWith(later, earlier)
    }
  }
}

function expectStartsWith(later: SentRequest, earlier: SentRequest): void {
  const pair = `${earlier.turn} then ${later.turn}`
  const replayed: readonly ModelMessage[] = later.messages.slice(0, earlier.messages.length)

  expect({ pair, messages: replayed }).toEqual({ pair, messages: earlier.messages })
}

/** The user messages a request closes with the move note, by their text. */
function movedMessages(request: SentRequest): readonly string[] {
  return request.messages.flatMap((message) => {
    if (message.role !== "user") return []

    const texts = message.content.map((part) => (part.type === "text" ? part.text : ""))
    return texts.some((text) => text.includes(renderWorkspaceMovedTag())) ? [texts[0] ?? ""] : []
  })
}

// Guard proof for the scenarios below: mark the first user message after `thread.movedAt` again in
// detectMovedMessages (run-turn.ts), as the fallback this replaced did. The tag it adds moves to
// another message at the next move, and the round trips, the queued turn and the fork fail.

test("a round trip with no turn in between leaves the history it comes back to as it was sent", async () => {
  const conversation = await MovingConversation.start()
  await conversation.turn()
  await conversation.moveTo(APP_FOLDER)
  await conversation.moveTo("cloud")
  await conversation.turn()
  await conversation.turn()
  await conversation.moveTo(APP_FOLDER)
  await conversation.turn()
  await conversation.moveTo("cloud")
  const last = await conversation.turn()

  // The cloud kept its workspace: U2 ran where U1 did, so only the turns that changed it say so.
  expect(movedMessages(last)).toEqual(["U4", "U5"])
  expectEachWorkspaceReplaysItsRequests(conversation.requests)
})

test("round trips with a turn in each workspace keep each workspace's prefix", async () => {
  const conversation = await MovingConversation.start()
  await conversation.turn()
  for (const workspace of [APP_FOLDER, "cloud", APP_FOLDER, "cloud"] as const) {
    await conversation.moveTo(workspace)
    await conversation.turn()
  }

  expect(movedMessages(conversation.requests.at(-1) as SentRequest)).toEqual([
    "U2",
    "U3",
    "U4",
    "U5",
  ])
  expectEachWorkspaceReplaysItsRequests(conversation.requests)
})

test("moves between folders keep each folder's prefix, a return with no turn included", async () => {
  const conversation = await MovingConversation.start()
  await conversation.moveTo(APP_FOLDER)
  await conversation.turn()
  for (const workspace of [DOCS_FOLDER, SITE_FOLDER, APP_FOLDER]) {
    await conversation.moveTo(workspace)
    await conversation.turn()
  }
  await conversation.moveTo(DOCS_FOLDER)
  await conversation.moveTo(APP_FOLDER)
  const last = await conversation.turn()

  expect(movedMessages(last)).toEqual(["U2", "U3", "U4"])
  expectEachWorkspaceReplaysItsRequests(conversation.requests)
})

test("a retried turn replays the bytes its failed attempt sent, where it runs again", async () => {
  const conversation = await MovingConversation.start()
  await conversation.turn()
  const failed = await conversation.turn({ fails: true })
  const retried = await conversation.retry("thread_message_2_run")
  await conversation.turn()

  expect(retried.messages).toEqual(failed.messages)
  expectEachWorkspaceReplaysItsRequests(conversation.requests)

  // Retried on the computer, U4 crossed the move there: the cloud reads its cache again up to U4,
  // the message its failed attempt ended on, which the retry answered elsewhere.
  const failedInCloud = await conversation.turn({ fails: true })
  await conversation.moveTo(APP_FOLDER)
  await conversation.retry("thread_message_4_run")
  await conversation.turn()
  await conversation.moveTo("cloud")
  const back = await conversation.turn()

  expect(movedMessages(back)).toEqual(["U4", "U6"])
  expect(back.messages.slice(0, failedInCloud.messages.length - 1)).toEqual(
    failedInCloud.messages.slice(0, -1)
  )
  expectEachWorkspaceReplaysItsRequests(conversation.requests)
})

test("a queued turn a move takes elsewhere says so once, wherever the conversation goes next", async () => {
  const conversation = await MovingConversation.start()
  await conversation.moveTo(APP_FOLDER)
  await conversation.turn()
  const queued = await conversation.queue()
  await conversation.moveTo(DOCS_FOLDER)
  await conversation.moveTo("cloud")
  await conversation.run(queued)
  await conversation.turn()
  await conversation.moveTo(APP_FOLDER)
  await conversation.turn()
  await conversation.moveTo("cloud")
  const last = await conversation.turn()

  expect(movedMessages(last)).toEqual(["U2", "U4", "U5"])
  expectEachWorkspaceReplaysItsRequests(conversation.requests)
})

test("a fork's first turn says it starts elsewhere, and keeps saying it after the fork moves", async () => {
  const source = await MovingConversation.start(APP_FOLDER)
  await source.turn()
  await source.turn()

  const fork = await source.fork()
  await fork.turn()
  await fork.turn()
  await fork.moveTo(APP_FOLDER)
  await fork.turn()
  await fork.moveTo("cloud")
  const last = await fork.turn()

  // The copies were answered in the source's workspace, which the fork does not have.
  expect(movedMessages(last)).toEqual(["F1", "F3", "F4"])
  expectEachWorkspaceReplaysItsRequests(fork.requests)
})

test("a compaction across a move keeps the note on the message that crossed it", async () => {
  const conversation = await MovingConversation.start()
  await conversation.turn()
  await conversation.turn()
  await conversation.moveTo(APP_FOLDER)
  const compacted = await conversation.turn({ compacts: "before its message" })
  await conversation.turn()
  await conversation.moveTo("cloud")
  await conversation.turn()
  await conversation.moveTo(APP_FOLDER)
  const last = await conversation.turn()

  expect(compacted.checkpointId).toBeDefined()
  expect(movedMessages(compacted)).toEqual(["U3"])
  expect(movedMessages(last)).toEqual(["U3", "U5", "U6"])
  expectEachWorkspaceReplaysItsRequests(conversation.requests)
})

test("a fork whose first turn compacts what it copied still says that turn started elsewhere", async () => {
  // Proven by removal: start `inherited` false in detectMovedMessages; once the copies are
  // summarized, nothing before F1 shows that the fork's history comes from another workspace.
  const source = await MovingConversation.start(APP_FOLDER)
  await source.turn()
  await source.turn()

  const fork = await source.fork()
  const compacted = await fork.turn({ compacts: "before its message" })
  const last = await fork.turn()

  expect(compacted.checkpointId).toBeDefined()
  expect(movedMessages(last)).toEqual(["F1"])
  expectEachWorkspaceReplaysItsRequests(fork.requests)
})

test("a message sent while a turn waited does not hide where that turn ran", async () => {
  // Proven by removal: look for the run before the history only among the runs that started
  // before its oldest message; the waiting turn started after the message sent meanwhile, so the
  // cloud turn before it is taken for the previous place, and U3 reads as moved.
  const conversation = await MovingConversation.start()
  await conversation.turn()
  await conversation.moveTo(APP_FOLDER)
  const waiting = await conversation.queue()
  await conversation.steer("Also check the tests.")
  await conversation.run(waiting)
  const last = await conversation.turn({ compacts: "before the last steer" })

  // The waiting turn read the steer and saved it, with no run of its own: it is the oldest message
  // the last turn keeps after its summary.
  expect(last.messages[1]?.content[0]).toEqual({ type: "text", text: "Also check the tests." })
  expect(movedMessages(last)).toEqual([])
  expectEachWorkspaceReplaysItsRequests(conversation.requests)
})

test("editing an earlier turn preserves exact prefix bytes, pinned memory, and cache affinity while dropping later turns", async () => {
  // Guard proof: omit checkpoints.deleteAfterSeq or messages.deleteFromSeq on rewind, or load
  // memory as of now instead of thread.createdAt; the prefix bytes diverge or Turn 3 leaks.
  const seeded = await seedThread(false)
  const { storage } = seeded
  const agents = storage.agents

  // Save a memory entry AFTER Turn 1/Turn 2 started, as a later Turn 3 might have done.
  await agents.memory.save({
    projectId,
    repoId: "project",
    baseRevision: 0,
    message: "Later turn memory",
    author: { type: "user", id: "user" },
    changes: [{ path: "MEMORY.md", contents: "# Memory\n\n- Secret from deleted Turn 3\n" }],
    createdAt: new Date(Date.now() + 60_000),
  })

  // Capture exact request bytes and caching intent when Turn 2 originally runs.
  let originalMessagesSent: readonly ModelMessage[] | undefined
  let originalCaching: unknown
  const firstModel = new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
      originalMessagesSent = options.messages
      originalCaching = options.caching
      return testStream([
        { type: "stream-start" },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Original reply 2" },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", usage },
      ])
    },
  })

  const baseContext = {
    id: projectId,
    authorPrincipal: { type: "serviceAccount" as const, id: "service_agent" },
    blobStorage: new InMemoryBlobStorage(),
    tools: [],
    systemPrompt: "Test system prompt.",
    projectTimeZone: "UTC",
    projectLocale: "en",
  }

  await runTurnInSession({
    storage: requireWorkerStorage(storage),
    context: baseContext,
    plan: {
      instructions: "Answer clearly.",
      model: firstModel,
      recordedModel: firstModel,
      tools: [],
      skills: [],
      ontologyDocs: { files: [], index: [] },
    },
    run: seeded.run,
    signal: new AbortController().signal,
  })

  // Append Turn 3 + checkpoint that summarizes through Turn 2.
  await agents.messages.append({
    id: "message_5",
    projectId,
    threadId,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "Turn 3 secret follow-up" }],
  })
  const exec3 = await createTestAgentExecution(storage, { projectId, runId: "run_3" })
  await agents.runs.create({
    id: "run_3",
    projectId,
    executionId: exec3,
    threadId,
    triggerMessageId: "message_5",
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  await agents.runs.start({
    id: "run_3",
    projectId,
    execution: {
      token: "execution_3",
      queueLeaseExpiresAt: new Date("2026-08-27T12:20:00.000Z"),
    },
  })
  await agents.checkpoints.create({
    id: "checkpoint_future",
    projectId,
    threadId,
    createdByRunId: "run_3",
    expectedPreviousCheckpointId: null,
    expectedHeadSeq: 5,
    executionToken: "execution_3",
    reason: "threshold",
    summary: "Summary mentioning Turn 3 secret follow-up.",
    summaryFormatVersion: 1,
    summarizedThroughSeq: 4,
    observedHeadSeq: 5,
    estimatedInputTokensBefore: 2_000,
    estimatedInputTokensAfter: 400,
    summaryModelId: "test-model",
  })
  await agents.runs.finish({
    id: "run_3",
    projectId,
    executionToken: "execution_3",
    status: "succeeded",
  })

  // Rewind Turn 2 (seq 3): delete checkpoints > 2 and messages >= 3, then append edited Turn 2.
  await agents.checkpoints.deleteAfterSeq({ projectId, threadId, afterSeq: 2 })
  await agents.messages.deleteFromSeq({ projectId, threadId, fromSeq: 3 })
  const editedMsg = await agents.messages.append({
    id: "message_3_edited",
    projectId,
    threadId,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "three (edited)" }],
  })
  expect(editedMsg.seq).toBe(3)

  const execEdited = await createTestAgentExecution(storage, { projectId, runId: "run_2_edited" })
  await agents.runs.create({
    id: "run_2_edited",
    projectId,
    executionId: execEdited,
    threadId,
    triggerMessageId: "message_3_edited",
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  const startedEdited = await agents.runs.start({
    id: "run_2_edited",
    projectId,
    execution: {
      token: "execution_2_edited",
      queueLeaseExpiresAt: new Date("2026-08-27T12:25:00.000Z"),
    },
  })
  if (startedEdited.kind !== "conversation") throw new Error("Expected conversation run")

  let rewoundMessagesSent: readonly ModelMessage[] | undefined
  let rewoundCaching: unknown
  const secondModel = new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
      rewoundMessagesSent = options.messages
      rewoundCaching = options.caching
      return testStream([
        { type: "stream-start" },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Edited reply 2" },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", usage },
      ])
    },
  })

  await runTurnInSession({
    storage: requireWorkerStorage(storage),
    context: baseContext,
    plan: {
      instructions: "Answer clearly.",
      model: secondModel,
      recordedModel: secondModel,
      tools: [],
      skills: [],
      ontologyDocs: { files: [], index: [] },
    },
    run: startedEdited,
    signal: new AbortController().signal,
  })

  if (!originalMessagesSent || !rewoundMessagesSent) {
    throw new Error("Expected both prompts to be captured.")
  }

  // Same threadId keeps exact cache intent & x-session-affinity key.
  expect(rewoundCaching).toEqual(originalCaching)
  // System prompt + Turn 1 user + Turn 1 assistant prefix is byte-for-byte identical.
  expect(rewoundMessagesSent.slice(0, -1)).toEqual(originalMessagesSent.slice(0, -1))
  // Nothing from Turn 2 original, Turn 3, or the deleted checkpoint/memory appears.
  const serialized = JSON.stringify(rewoundMessagesSent)
  expect(serialized).toContain("three (edited)")
  expect(serialized).not.toContain("Original reply 2")
  expect(serialized).not.toContain("Turn 3 secret")
  expect(serialized).not.toContain("Secret from deleted Turn 3")
})
