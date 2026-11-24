import { describe, expect, mock, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  type EmbeddingModel,
  type EmbeddingModelResult,
  type SixbErrorContext,
  SixbHost,
} from "../src"
import { AgentTurnIndexingDeferred, getAgentTurnIndexing } from "../src/agents"
import type { AgentMessagePart } from "../src/agents/message"
import { agentTurnVectorConfiguration } from "../src/agents/turn-vectors/configuration"
import {
  agentTurnChunks,
  splitAgentTurns,
  TURN_CHUNK_MAX_CHARS,
} from "../src/agents/turn-vectors/turns"
import type { UserPrincipal } from "../src/auth"
import type { FileRef } from "../src/blob-storage/types"
import type { AgentMessageRecord } from "../src/storage/agents"
import { createTestAgentExecution } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const alice: UserPrincipal = { type: "user", id: "usr_alice" }
const bob: UserPrincipal = { type: "user", id: "usr_bob" }
const t0 = Date.parse("2026-11-20T09:00:00.000Z")

function at(seconds: number): Date {
  return new Date(t0 + seconds * 1000)
}

function message(
  seq: number,
  role: AgentMessageRecord["role"],
  parts: readonly AgentMessagePart[],
  runId: string | null = null
): AgentMessageRecord {
  return {
    id: `msg_${seq}`,
    projectId: "p",
    threadId: "thr_1",
    runId,
    role,
    seq,
    parts,
    contentVersion: 2,
    createdAt: at(seq),
  }
}

describe("splitAgentTurns", () => {
  test("a turn is a person's message and the Agent's final answer to it", () => {
    const turns = splitAgentTurns([
      message(1, "user", [
        { type: "text", text: "Which deals slipped?" },
        {
          type: "file",
          fileRef: {
            blobId: `blob_${"a".repeat(64)}`,
            digest: `sha256:${"a".repeat(64)}`,
            sizeBytes: 3,
            fileName: "pipeline.csv",
          },
        },
      ]),
      message(
        2,
        "assistant",
        [
          { type: "step-start" },
          { type: "reasoning", text: "I should read the file." },
          { type: "text", text: "Let me look." },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "bash",
            input: { command: "cat pipeline.csv" },
            state: "output-available",
            output: "Acme,slipped",
          },
          { type: "step-start" },
          { type: "text", text: "Acme slipped." },
        ],
        "run_1"
      ),
      // Resuming a paused turn with how its calls ended goes on with the same turn.
      message(3, "user", [
        { type: "approval-outcome", approvalId: "apr_1", status: "approved", outcome: "ran" },
      ] as unknown as AgentMessagePart[]),
      message(
        4,
        "assistant",
        [{ type: "step-start" }, { type: "text", text: "Also Initech." }],
        "run_2"
      ),
      // A steer is a message of its own.
      message(5, "user", [{ type: "text", text: "Only this quarter." }]),
      message(6, "assistant", [{ type: "text", text: "Then only Acme." }], "run_2"),
    ])

    expect(turns).toEqual([
      {
        messageId: "msg_1",
        firstSeq: 1,
        lastSeq: 4,
        turnAt: at(1),
        request: "Which deals slipped?\nAttached: pipeline.csv",
        answer: "Acme slipped.\nAlso Initech.",
        runIds: ["run_1", "run_2"],
      },
      {
        messageId: "msg_5",
        firstSeq: 5,
        lastSeq: 6,
        turnAt: at(5),
        request: "Only this quarter.",
        answer: "Then only Acme.",
        runIds: ["run_2"],
      },
    ])
  })

  test("what comes before the first message that opens a turn is left out", () => {
    const turns = splitAgentTurns([
      message(4, "assistant", [{ type: "text", text: "the end of an earlier turn" }], "run_1"),
      message(5, "user", [{ type: "continuation" }]),
      message(6, "user", [{ type: "text", text: "Next question" }]),
    ])

    expect(turns.map((turn) => [turn.messageId, turn.answer])).toEqual([["msg_6", ""]])
  })
})

describe("agentTurnChunks", () => {
  test("a turn that fits is one input, with what it published", () => {
    expect(
      agentTurnChunks({ request: "Draft the email", answer: "Here it is." }, ["Acme follow-up"])
    ).toEqual(["Request: Draft the email\n\nAnswer: Here it is.\n\nPublished: Acme follow-up"])
    expect(agentTurnChunks({ request: "", answer: "" }, [])).toEqual([])
  })

  test("a long turn is cut into chunks that each say what was asked", () => {
    const answer = Array.from({ length: 3000 }, (_, index) => `word${index}`).join(" ")
    const chunks = agentTurnChunks({ request: "Summarize the contract", answer }, [])

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TURN_CHUNK_MAX_CHARS)
      expect(chunk.startsWith("Request: Summarize the contract")).toBe(true)
    }
    // Cut between words, so nothing is lost but the spaces.
    const words = chunks.flatMap((chunk, index) =>
      (index === 0 ? chunk : chunk.slice("Request: Summarize the contract\n\n".length))
        .replace("Request: Summarize the contract\n\nAnswer: ", "")
        .split(/\s+/)
    )
    expect(words).toEqual(answer.split(" "))
  })

  test("a model's byte bound cuts by bytes, never inside a character", () => {
    const answer = "é".repeat(2000)
    const chunks = agentTurnChunks({ request: "Résumé", answer }, [], { maxBytes: 1000 })

    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(1000)
      expect(chunk).not.toContain("�")
    }
    expect(chunks.join("").split("é").length - 1).toBeGreaterThanOrEqual(2000)
  })
})

function fixture(batching: EmbeddingModel["batching"] = defaultBatching) {
  const deps = createTestRuntimeDeps()
  const embed = mock(
    async (input: { readonly texts: readonly string[] }): Promise<EmbeddingModelResult> => ({
      vectors: input.texts.map((_, index) => [3, 4 + index]),
      usage: { inputTokens: 10 },
    })
  )
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    batching,
    embed,
  }
  const failures: SixbErrorContext[] = []
  const host = new SixbHost({
    id: "turns",
    ontology: [],
    models: { embedding: [model] },
    onError: (_error, context) => {
      failures.push(context)
    },
    ...deps,
  })
  const indexing = getAgentTurnIndexing(host)!
  const agents = deps.storage.agents
  const projectId = host.id
  const configuration = agentTurnVectorConfiguration(model)

  /** A turn its requester asked and the Agent answered, as a finished run. */
  const turn = async (threadId: string, n: number, requester: UserPrincipal = alice) => {
    await agents.messages.append({
      id: `${threadId}_q${n}`,
      projectId,
      threadId,
      runId: null,
      role: "user",
      authorPrincipal: requester,
      parts: [{ type: "text", text: `Question ${n}` }],
      createdAt: at(n * 10),
    })
    const runId = `${threadId}_run_${n}`
    const executionId = await createTestAgentExecution(deps.storage, {
      projectId,
      runId,
      requestedBy: requester,
    })
    await agents.runs.create({
      id: runId,
      projectId,
      executionId,
      threadId,
      triggerMessageId: `${threadId}_q${n}`,
      spec: { model: { provider: "test", modelId: "large" } },
      createdAt: at(n * 10),
    })
    await agents.runs.start({
      id: runId,
      projectId,
      execution: { token: `exec_${runId}`, queueLeaseExpiresAt: new Date(t0 + 3_600_000) },
    })
    await agents.messages.append({
      id: `${threadId}_a${n}`,
      projectId,
      threadId,
      runId,
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-call",
          toolCallId: `call_${n}`,
          toolName: "bash",
          input: { command: "ls" },
          state: "output-available",
          output: "secret tool output",
        },
        { type: "step-start" },
        { type: "text", text: `Answer ${n}` },
      ],
      createdAt: at(n * 10 + 1),
    })
    await agents.runs.finish({
      id: runId,
      projectId,
      executionToken: `exec_${runId}`,
      status: "succeeded",
    })
    return { runId, executionId }
  }

  const conversation = (threadId: string) =>
    agents.threads.create({ id: threadId, projectId, ownerPrincipal: alice, createdAt: at(0) })

  const index = (threadId: string) => indexing.index(threadId, 1, new AbortController().signal)

  /** The calls recorded under an execution. */
  const callsOn = async (executionId: string) =>
    (await deps.storage.aiUsage.summarizeExecution({ projectId, executionId })).modelCallCount

  const progress = (threadId: string) =>
    agents.turnVectors.progress({ projectId, threadId, configuration })

  const vectors = async (threadId: string) =>
    (await agents.turnVectors.list({ projectId, threadId })).map((vector) => vector.text)

  return {
    ...deps,
    host,
    indexing,
    agents,
    projectId,
    configuration,
    embed,
    failures,
    turn,
    conversation,
    index,
    progress,
    vectors,
    callsOn,
  }
}

const defaultBatching = { maxInputs: 8, maxInputBytes: 100_000, maxTotalInputBytes: 100_000 }

describe("agent turn indexing", () => {
  test("indexes each turn's request, final answer and published titles, on the project's budget", async () => {
    // Guard proof: record the calls on the turn's run, as its requester; Alice's limit refuses
    // them, and her run's execution counts them.
    const f = fixture()
    await f.conversation("thr_1")
    const first = await f.turn("thr_1", 1)
    await f.storage.artifacts.create({
      projectId: f.projectId,
      id: "art_email",
      kind: "document",
      owner: alice,
      turnRunId: first.runId,
      version: {
        title: "Acme follow-up",
        entry: "document.md",
        files: [{ path: "document.md", file: fileRef("email") }],
        outline: { kind: "document", headings: [] },
        references: [],
        author: alice,
        updatedAt: at(12),
      },
    })
    const second = await f.turn("thr_1", 2, bob)

    // Alice has used up her own limit: indexing is not hers to pay for.
    await f.storage.aiLimits.createPolicy({
      id: "alice",
      projectId: f.projectId,
      subject: { type: "user", id: alice.id },
      limit: { meter: "tokens.total", amount: 1 },
    })

    await f.index("thr_1")

    expect(await f.vectors("thr_1")).toEqual([
      "Request: Question 1\n\nAnswer: Answer 1\n\nPublished: Acme follow-up",
      "Request: Question 2\n\nAnswer: Answer 2",
    ])
    const [stored] = await f.agents.turnVectors.list({ projectId: f.projectId, threadId: "thr_1" })
    expect(stored!.embedding).toEqual([Math.fround(0.6), Math.fround(0.8)])
    expect(stored!.configuration).toBe(f.configuration)
    expect(await f.progress("thr_1")).toMatchObject({ current: true, fromSeq: 3 })

    // One call for both people's turns, on the thread's own execution, which no one requested.
    expect(f.embed).toHaveBeenCalledTimes(1)
    expect(await f.callsOn("exec_turns_thr_1")).toBe(1)
    expect(await f.callsOn(first.executionId)).toBe(0)
    expect(await f.callsOn(second.executionId)).toBe(0)
    expect(
      await f.storage.executions.getById({ projectId: f.projectId, id: "exec_turns_thr_1" })
    ).toMatchObject({
      executor: { type: "kernel", operation: { type: "agents.indexTurns", threadId: "thr_1" } },
      requesterGroupIds: [],
    })
    expect(
      (await f.storage.executions.getById({ projectId: f.projectId, id: "exec_turns_thr_1" }))
        ?.requestedBy
    ).toBeUndefined()
  })

  test("reads again from the newest turn, and pays only for text that changed", async () => {
    // Guard proof: drop the reuse of stored vectors whose text is unchanged; the second pass
    // embeds turn 2 again.
    const f = fixture()
    await f.conversation("thr_1")
    await f.turn("thr_1", 1)
    await f.turn("thr_1", 2)
    await f.index("thr_1")
    f.embed.mockClear()

    await f.turn("thr_1", 3)
    await f.index("thr_1")

    expect(f.embed.mock.calls.map(([input]) => input.texts)).toEqual([
      ["Request: Question 3\n\nAnswer: Answer 3"],
    ])
    expect(await f.vectors("thr_1")).toHaveLength(3)

    // Nothing changed since: nothing to read, nothing to pay.
    f.embed.mockClear()
    await f.index("thr_1")
    expect(f.embed).not.toHaveBeenCalled()
  })

  test("waits for the project's AI limit, keeping what it already paid for", async () => {
    // One turn per call, so the limit can admit the first and refuse the second.
    const f = fixture({ maxInputs: 1, maxInputBytes: 100_000, maxTotalInputBytes: 100_000 })
    await f.conversation("thr_1")
    await f.turn("thr_1", 1)
    await f.turn("thr_1", 2)

    // The limit admits the first turn's call, then refuses the second's.
    await f.storage.aiLimits.createPolicy({
      id: "tokens",
      projectId: f.projectId,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 15 },
    })

    const deferred = await f.index("thr_1").catch((error: unknown) => error)
    expect(deferred).toBeInstanceOf(AgentTurnIndexingDeferred)
    expect(Date.parse((deferred as AgentTurnIndexingDeferred).availableAt)).toBeGreaterThan(
      Date.now()
    )
    expect(await f.vectors("thr_1")).toEqual(["Request: Question 1\n\nAnswer: Answer 1"])
    expect(f.embed).toHaveBeenCalledTimes(1)

    // The thread waits for the reset: no pass asks for it, and its job waits too.
    expect(await f.progress("thr_1")).toMatchObject({
      current: false,
      failures: 0,
      deferredUntil: new Date((deferred as AgentTurnIndexingDeferred).availableAt),
    })
    await f.indexing.repair()
    await f.indexing.request("thr_1")
    expect(await claimAll(f)).toEqual([])
    const early = await f.index("thr_1").catch((error: unknown) => error)
    expect(early).toBeInstanceOf(AgentTurnIndexingDeferred)
    expect(f.embed).toHaveBeenCalledTimes(1)
  })

  test("a failure waits longer each time, and a write starts over", async () => {
    // Guard proof: drop `store.defer` from the failure path; the repair pass asks for the
    // failing thread again at once.
    const f = fixture()
    await f.conversation("thr_1")
    await f.turn("thr_1", 1)
    f.embed.mockRejectedValueOnce(new Error("Provider unavailable"))

    const before = Date.now()
    const failed = await f.index("thr_1").catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(AgentTurnIndexingDeferred)
    expect((failed as AgentTurnIndexingDeferred).cause).toBeInstanceOf(Error)
    const progress = await f.progress("thr_1")
    expect(progress!.failures).toBe(1)
    expect(progress!.deferredUntil!.getTime()).toBeGreaterThanOrEqual(before + 60_000)

    await f.indexing.repair()
    expect(await claimAll(f)).toEqual([])

    // Once the backoff is over, the next try writes and clears the failures.
    await f.agents.turnVectors.defer({
      projectId: f.projectId,
      threadId: "thr_1",
      configuration: f.configuration,
      until: new Date(before - 1000),
      failed: false,
    })
    await f.index("thr_1")
    expect(await f.progress("thr_1")).toMatchObject({ current: true, failures: 0 })
    expect((await f.progress("thr_1"))!.deferredUntil).toBeUndefined()
  })

  test("a failure no retry fixes is reported once, and waits for the thread to change", async () => {
    // Guard proof: back off from a non-retryable failure as from any other; it is never reported,
    // and the job pays for the same failure again once the backoff ends.
    const f = fixture()
    await f.conversation("thr_1")
    await f.turn("thr_1", 1)
    // The model answers with three values where it declares two: every try fails the same way.
    f.embed.mockImplementation(async (input) => ({
      vectors: input.texts.map(() => [1, 2, 3]),
      usage: { inputTokens: 10 },
    }))

    await f.index("thr_1")

    expect(f.failures).toEqual([
      expect.objectContaining({
        type: "agent.turn_indexing.failed",
        threadId: "thr_1",
        revision: (await f.progress("thr_1"))!.revision,
        failure: expect.objectContaining({ code: "vector.response_invalid", retryable: false }),
      }),
    ])
    expect(await f.progress("thr_1")).toMatchObject({ current: false, halted: true, failures: 0 })

    // Nothing asks for it again, and a job that runs anyway pays nothing.
    await f.indexing.repair()
    await f.indexing.request("thr_1")
    expect(await claimAll(f)).toEqual([])
    await f.index("thr_1")
    expect(f.embed).toHaveBeenCalledTimes(1)
    expect(f.failures).toHaveLength(1)

    // A new turn is a new state: it is tried, and reported, again.
    await f.turn("thr_1", 2)
    await f.indexing.request("thr_1")
    expect(await claimAll(f)).toHaveLength(1)
    await f.index("thr_1")
    expect(f.embed).toHaveBeenCalledTimes(2)
    expect(f.failures).toHaveLength(2)
  })

  test("leaves a thread a turn holds, and a storage that cannot search", async () => {
    const f = fixture()
    await f.conversation("thr_1")
    await f.turn("thr_1", 1)
    await f.agents.messages.append({
      id: "thr_1_q2",
      projectId: f.projectId,
      threadId: "thr_1",
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "Question 2" }],
    })
    const executionId = await createTestAgentExecution(f.storage, {
      projectId: f.projectId,
      runId: "run_active",
    })
    await f.agents.runs.create({
      id: "run_active",
      projectId: f.projectId,
      executionId,
      threadId: "thr_1",
      triggerMessageId: "thr_1_q2",
      spec: { model: { provider: "test", modelId: "large" } },
    })

    await f.index("thr_1")
    expect(f.embed).not.toHaveBeenCalled()

    await f.conversation("thr_2")
    await f.turn("thr_2", 1)
    // The store is behind the storage's operation scope: its class answers for it.
    const cannotSearch = spyOn(
      Object.getPrototypeOf(f.agents.turnVectors) as typeof f.agents.turnVectors,
      "searchAvailable"
    ).mockResolvedValue(false)
    try {
      await f.index("thr_2")
      await f.indexing.request("thr_2")
      await f.indexing.repair()
    } finally {
      cannotSearch.mockRestore()
    }

    expect(f.embed).not.toHaveBeenCalled()
    expect(await claimAll(f)).toEqual([])
  })

  test("a turn's end asks again even after a job for the same state ran", async () => {
    const f = fixture()
    await f.conversation("thr_1")
    await f.turn("thr_1", 1)

    await f.indexing.request("thr_1")
    const [first] = await claimAll(f)
    expect(first).toMatchObject({
      type: "agent.thread.index.requested",
      payload: { threadId: "thr_1" },
    })
    await f.queues.turnIndexing.complete({
      projectId: f.projectId,
      jobId: first!.id,
      leaseId: first!.leaseId,
    })

    // Guard proof: enqueue without `replace`; the completed job absorbs the request.
    await f.indexing.request("thr_1")
    expect((await claimAll(f)).map((job) => job.id)).toEqual([first!.id])
  })

  test("the repair pass asks for every conversation behind, and leaves a deferred one waiting", async () => {
    // Guard proof: drop the deferral filter from listThreadsToIndex; the deferred thread's job is
    // replaced by one due now.
    const f = fixture()
    await f.conversation("thr_old")
    await f.turn("thr_old", 1)
    await f.conversation("thr_done")
    await f.turn("thr_done", 2)
    await f.index("thr_done")

    await f.conversation("thr_deferred")
    await f.turn("thr_deferred", 3)
    await f.agents.turnVectors.defer({
      projectId: f.projectId,
      threadId: "thr_deferred",
      configuration: f.configuration,
      until: new Date(Date.now() + 3_600_000),
      failed: false,
    })

    await f.indexing.repair()

    expect((await claimAll(f)).map((job) => job.payload)).toEqual([{ threadId: "thr_old" }])
  })

  test("one thread is indexed by one worker at a time", async () => {
    // Guard proof: name each job by the thread's revision again; the second turn's job is claimed
    // beside the first, and both pay for the same turns.
    const f = fixture()
    await f.conversation("thr_1")
    await f.turn("thr_1", 1)
    await f.indexing.request("thr_1")
    await f.indexing.repair()

    const [first, ...others] = await claimAll(f)
    expect(others).toEqual([])

    // Another turn ends while the first job runs: its ask waits behind the claimed job.
    await f.turn("thr_1", 2)
    await f.indexing.request("thr_1")
    await f.indexing.repair()
    expect(await claimAll(f, "other-worker")).toEqual([])

    await f.queues.turnIndexing.complete({
      projectId: f.projectId,
      jobId: first!.id,
      leaseId: first!.leaseId,
    })
    expect((await claimAll(f, "other-worker")).map((job) => job.id)).toEqual([first!.id])
  })
})

async function claimAll(f: ReturnType<typeof fixture>, workerId = "test") {
  const claimed = await f.queues.turnIndexing.claim({
    projectId: f.projectId,
    workerId,
    limit: 100,
  })
  return claimed.map(({ job, leaseId }) => ({ ...job, leaseId }))
}

function fileRef(name: string): FileRef {
  const hex = createHash("sha256").update(name).digest("hex")
  return {
    blobId: `blob_${hex}`,
    digest: `sha256:${hex}`,
    sizeBytes: 1,
    mediaType: "text/markdown",
  }
}
