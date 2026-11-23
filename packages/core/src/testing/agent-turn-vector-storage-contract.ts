import { describe, expect, test } from "bun:test"
import type { UserPrincipal } from "../auth"
import {
  type AgentStorage,
  AgentStorageError,
  type AgentTurnVectorInput,
  type SearchAgentTurnVectorsInput,
  type WriteAgentTurnVectorsInput,
} from "../storage/agents"
import type { AuthStorage } from "../storage/auth"
import type { ExecutionStorage } from "../storage/executions"
import { createTestAgentExecution } from "./agent-execution"

export interface AgentTurnVectorStorageContractStorage {
  readonly agents: AgentStorage
  readonly auth: AuthStorage
  readonly executions: ExecutionStorage
}

export interface AgentTurnVectorStorageContractSuiteOptions<
  TStorage extends AgentTurnVectorStorageContractStorage = AgentTurnVectorStorageContractStorage,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly teardown?: (storage: TStorage) => void | Promise<void>
  /**
   * Whether this storage can search here, true by default: false skips the searches, for a SQLite
   * that cannot load sqlite-vec.
   */
  readonly searches?: boolean
}

const projectId = "turn-vectors-contract"
const alice: UserPrincipal = { type: "user", id: "usr_alice" }
const bob: UserPrincipal = { type: "user", id: "usr_bob" }
const carol: UserPrincipal = { type: "user", id: "usr_carol" }
const configuration = "cfg_model_a"
const otherConfiguration = "cfg_model_b"
const t0 = Date.parse("2026-11-20T09:00:00.000Z")

/** Exactly representable in float32, so every provider reads back what it was given. */
const vectorA = [0.5, -0.25, 0.75]
const vectorB = [-0.5, 0.125, 0.25]

/** Searches ask with `east`: a chunk scores 1, 0.6, 0 and -1 against it. */
const east = [1, 0, 0]
const northeast = [0.6, 0.8, 0]
const north = [0, 1, 0]
const west = [-1, 0, 0]

function at(seconds: number): Date {
  return new Date(t0 + seconds * 1000)
}

/** Provider-neutral persistence contract for `agent_turn_vectors` and the index state. */
export function runAgentTurnVectorStorageContractSuite<
  TStorage extends AgentTurnVectorStorageContractStorage,
>(label: string, options: AgentTurnVectorStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  /** A conversation of question-and-answer turns: `${threadId}_q${n}` then `${threadId}_a${n}`. */
  const conversation = async (
    storage: TStorage,
    threadId: string,
    turns: number,
    startAt = 0
  ): Promise<void> => {
    await storage.agents.threads.create({
      id: threadId,
      projectId,
      ownerPrincipal: alice,
      createdAt: at(startAt),
    })

    for (let turn = 1; turn <= turns; turn++)
      await ask(storage, threadId, turn, startAt + turn * 10)
  }

  const ask = async (
    storage: TStorage,
    threadId: string,
    turn: number,
    seconds: number,
    answeredBy: string | null = null
  ): Promise<void> => {
    await storage.agents.messages.append({
      id: `${threadId}_q${turn}`,
      projectId,
      threadId,
      runId: null,
      role: "user",
      authorPrincipal: alice,
      parts: [{ type: "text", text: `Question ${turn}` }],
      createdAt: at(seconds),
    })
    await storage.agents.messages.append({
      id: `${threadId}_a${turn}`,
      projectId,
      threadId,
      runId: answeredBy,
      role: "assistant",
      parts: [{ type: "text", text: `Answer ${turn}` }],
      createdAt: at(seconds + 1),
    })
  }

  /**
   * `thr_busy`, whose turn still runs, and the thread of the sub-agent that turn spawned,
   * `thr_child`, opened by its task message `child_task`. The child has ended.
   */
  const busyConversationWithChild = async (storage: TStorage): Promise<void> => {
    await conversation(storage, "thr_busy", 0, 300)
    const parentExecution = await createTestAgentExecution(storage, {
      projectId,
      runId: "run_busy",
    })
    await storage.agents.messages.append({
      id: "thr_busy_q1",
      projectId,
      threadId: "thr_busy",
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "Research" }],
      createdAt: at(310),
    })
    await storage.agents.runs.create({
      id: "run_busy",
      projectId,
      executionId: parentExecution,
      threadId: "thr_busy",
      triggerMessageId: "thr_busy_q1",
      spec: { model: { provider: "test", modelId: "large" } },
      createdAt: at(310),
    })
    await storage.agents.runs.start({
      id: "run_busy",
      projectId,
      execution: { token: "exec_busy", queueLeaseExpiresAt: at(900) },
    })
    const childExecution = await createTestAgentExecution(storage, {
      projectId,
      runId: "child_1",
      sourceExecutionId: parentExecution,
    })
    await storage.agents.runs.createSubagent({
      id: "child_1",
      projectId,
      executionId: childExecution,
      parentRunId: "run_busy",
      parentExecutionToken: "exec_busy",
      spawnKey: "research",
      spec: {
        model: { provider: "test", modelId: "small" },
        task: "Research.",
        toolNames: [],
      },
      thread: { id: "thr_child", create: true },
      trigger: { id: "child_task", parts: [{ type: "text", text: "Research." }] },
      maxActiveChildren: 4,
      createdAt: at(320),
    })
    // The child ends, so only its kind keeps its thread out.
    await storage.agents.runs.finishQueued({
      id: "child_1",
      projectId,
      status: "cancelled",
      completedAt: at(330),
    })
  }

  /** Turn `n` of a conversation built by `conversation`: messages `2n - 1` and `2n`. */
  const turnVector = (
    threadId: string,
    turn: number,
    overrides: Partial<AgentTurnVectorInput> = {}
  ): AgentTurnVectorInput => ({
    messageId: `${threadId}_q${turn}`,
    chunk: 0,
    firstSeq: 2 * turn - 1,
    lastSeq: 2 * turn,
    turnAt: at(turn * 10),
    text: `Question ${turn}\n\nAnswer ${turn}`,
    embedding: vectorA,
    ...overrides,
  })

  /** Index the whole thread from what `progress` says now. */
  const indexAll = async (
    storage: TStorage,
    threadId: string,
    turns: readonly AgentTurnVectorInput[],
    overrides: Partial<WriteAgentTurnVectorsInput> = {}
  ): Promise<boolean> => {
    const progress = await storage.agents.turnVectors.progress({
      projectId,
      threadId,
      configuration,
    })
    return storage.agents.turnVectors.write({
      projectId,
      threadId,
      configuration,
      revision: progress!.revision,
      fromSeq: 1,
      turns,
      complete: true,
      indexedAt: at(100),
      ...overrides,
    })
  }

  const progressOf = (storage: TStorage, threadId: string, config = configuration) =>
    storage.agents.turnVectors.progress({ projectId, threadId, configuration: config })

  const threadsToIndex = async (storage: TStorage, config: string, limit: number) =>
    (
      await storage.agents.turnVectors.listThreadsToIndex({
        projectId,
        configuration: config,
        limit,
      })
    ).map((thread) => thread.threadId)

  const listed = async (storage: TStorage, threadId: string) =>
    (await storage.agents.turnVectors.list({ projectId, threadId })).map(
      (vector) => `${vector.messageId}#${vector.chunk}`
    )

  /** A conversation of `owner`'s, with these users added to it. */
  const ownedBy = async (
    storage: TStorage,
    threadId: string,
    owner: UserPrincipal,
    participants: readonly UserPrincipal[] = []
  ): Promise<void> => {
    await storage.agents.threads.create({
      id: threadId,
      projectId,
      ownerPrincipal: owner,
      createdAt: at(0),
    })
    if (participants.length === 0) return

    await storage.agents.threads.addParticipants({
      projectId,
      threadId,
      principals: participants,
      addedBy: owner,
      maxParticipants: 50,
    })
  }

  /** Turns asked in this order, each opened at `seconds`, with one embedding per chunk. */
  const indexTurns = async (
    storage: TStorage,
    threadId: string,
    turns: readonly {
      readonly seconds: number
      readonly chunks: readonly (readonly number[])[]
    }[],
    config = configuration
  ): Promise<void> => {
    for (const [index, { seconds }] of turns.entries()) {
      await ask(storage, threadId, index + 1, seconds)
    }

    const progress = await progressOf(storage, threadId, config)
    await storage.agents.turnVectors.write({
      projectId,
      threadId,
      configuration: config,
      revision: progress!.revision,
      fromSeq: 1,
      turns: turns.flatMap(({ seconds, chunks }, index) =>
        chunks.map((embedding, chunk) =>
          turnVector(threadId, index + 1, {
            chunk,
            turnAt: at(seconds),
            text: `Turn ${index + 1} of ${threadId}, part ${chunk}`,
            embedding,
          })
        )
      ),
      complete: true,
    })
  }

  const search = (storage: TStorage, input: Partial<SearchAgentTurnVectorsInput> = {}) =>
    storage.agents.turnVectors.search({
      projectId,
      configuration,
      vector: east,
      principal: alice,
      scope: "all",
      k: 100,
      perThread: 100,
      candidates: 1000,
      ...input,
    })

  /** Each hit as `messageId#chunk`, best first. */
  const found = async (storage: TStorage, input: Partial<SearchAgentTurnVectorsInput> = {}) =>
    (await search(storage, input)).hits.map((hit) => `${hit.messageId}#${hit.chunk}`)

  /** The conversations of the hits, each once. */
  const threadsFound = async (
    storage: TStorage,
    input: Partial<SearchAgentTurnVectorsInput> = {}
  ) => [...new Set((await search(storage, input)).hits.map((hit) => hit.threadId))]

  describe(label, () => {
    test("replaces a thread's turns from a seq on, and resumes at its newest turn", async () => {
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 2)
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: false, fromSeq: 1 })

        const turns = [
          turnVector("thr_1", 1),
          turnVector("thr_1", 2),
          turnVector("thr_1", 2, { chunk: 1, text: "Question 2\n\nmore", embedding: vectorB }),
        ]
        expect(await indexAll(storage, "thr_1", turns)).toBe(true)

        expect(await storage.agents.turnVectors.list({ projectId, threadId: "thr_1" })).toEqual(
          turns.map((turn) => ({
            ...turn,
            projectId,
            threadId: "thr_1",
            configuration,
            indexedAt: at(100),
          }))
        )
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: true, fromSeq: 3 })

        // A new turn: indexing reads again from the newest turn indexed, which may have grown.
        await ask(storage, "thr_1", 3, 30)
        const progress = await progressOf(storage, "thr_1")
        expect(progress).toMatchObject({ current: false, fromSeq: 3 })

        const written = await storage.agents.turnVectors.write({
          projectId,
          threadId: "thr_1",
          configuration,
          revision: progress!.revision,
          fromSeq: 3,
          turns: [turnVector("thr_1", 2), turnVector("thr_1", 3)],
          complete: true,
          indexedAt: at(200),
        })
        expect(written).toBe(true)

        const vectors = await storage.agents.turnVectors.list({ projectId, threadId: "thr_1" })
        expect(vectors.map((vector) => [vector.messageId, vector.chunk, vector.indexedAt])).toEqual(
          [
            ["thr_1_q1", 0, at(100)],
            ["thr_1_q2", 0, at(200)],
            ["thr_1_q3", 0, at(200)],
          ]
        )
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: true, fromSeq: 5 })
        expect(
          (await storage.agents.turnVectors.list({ projectId, threadId: "thr_1", fromSeq: 3 }))
            .length
        ).toBe(2)
      })
    })

    test("writes nothing once a message was added or taken since the thread was read", async () => {
      // Guard proof: drop the revision check from `write`; the turns read before the new message
      // are written, and the thread reads as indexed with that message left out.
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 1)
        const before = await progressOf(storage, "thr_1")

        await ask(storage, "thr_1", 2, 20)
        const written = await storage.agents.turnVectors.write({
          projectId,
          threadId: "thr_1",
          configuration,
          revision: before!.revision,
          fromSeq: 1,
          turns: [turnVector("thr_1", 1)],
          complete: true,
        })

        expect(written).toBe(false)
        expect(await listed(storage, "thr_1")).toEqual([])
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: false })

        const afterAppend = await progressOf(storage, "thr_1")
        await storage.agents.messages.deleteFromSeq({ projectId, threadId: "thr_1", fromSeq: 3 })
        expect(
          await indexAll(storage, "thr_1", [turnVector("thr_1", 1)], {
            revision: afterAppend!.revision,
          })
        ).toBe(false)
      })
    })

    test("a turn's vectors go with the message that opens it", async () => {
      // Guard proof: drop ON DELETE CASCADE from agent_turn_vectors' foreign key (in memory, the
      // delete in forgetDeletedMessages); the rewound turn's vector outlives its message.
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 2)
        await indexAll(storage, "thr_1", [turnVector("thr_1", 1), turnVector("thr_1", 2)])

        await storage.agents.messages.deleteFromSeq({ projectId, threadId: "thr_1", fromSeq: 3 })

        expect(await listed(storage, "thr_1")).toEqual(["thr_1_q1#0"])
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: false, fromSeq: 1 })
      })
    })

    test("a deletion inside an indexed turn sends indexing back to that turn", async () => {
      // Guard proof: drop the stale mark from deleteByRunId; indexing resumes at the newest turn
      // and the first keeps the answer the retry took away.
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 0)
        const executionId = await createTestAgentExecution(storage, { projectId, runId: "run_1" })
        await storage.agents.messages.append({
          id: "thr_1_q1",
          projectId,
          threadId: "thr_1",
          runId: null,
          role: "user",
          parts: [{ type: "text", text: "Question 1" }],
          createdAt: at(10),
        })
        await storage.agents.runs.create({
          id: "run_1",
          projectId,
          executionId,
          threadId: "thr_1",
          triggerMessageId: "thr_1_q1",
          spec: { model: { provider: "test", modelId: "large" } },
          createdAt: at(10),
        })
        await storage.agents.runs.start({
          id: "run_1",
          projectId,
          execution: { token: "exec_1", queueLeaseExpiresAt: at(600) },
        })
        await storage.agents.messages.append({
          id: "thr_1_a1",
          projectId,
          threadId: "thr_1",
          runId: "run_1",
          role: "assistant",
          parts: [{ type: "text", text: "Answer 1" }],
          createdAt: at(11),
        })
        await storage.agents.runs.finish({
          id: "run_1",
          projectId,
          executionToken: "exec_1",
          status: "failed",
          error: {
            code: "internal.unexpected",
            message: "The model failed.",
            retryable: false,
            at: at(12).toISOString(),
          },
        })
        await ask(storage, "thr_1", 2, 20)
        await indexAll(storage, "thr_1", [turnVector("thr_1", 1), turnVector("thr_1", 2)])
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: true, fromSeq: 3 })

        // A retry of the first turn takes its answer; the turn's opening message stays.
        await storage.agents.messages.deleteByRunId({
          projectId,
          threadId: "thr_1",
          runId: "run_1",
        })

        expect(await listed(storage, "thr_1")).toEqual(["thr_1_q1#0", "thr_1_q2#0"])
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: false, fromSeq: 1 })

        const progress = await progressOf(storage, "thr_1")
        await storage.agents.turnVectors.write({
          projectId,
          threadId: "thr_1",
          configuration,
          revision: progress!.revision,
          fromSeq: 1,
          turns: [
            turnVector("thr_1", 1, { lastSeq: 1, text: "Question 1" }),
            turnVector("thr_1", 2),
          ],
          complete: true,
        })
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: true, fromSeq: 3 })
      })
    })

    test("indexing part way leaves the thread to index, resuming at the newest turn written", async () => {
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 3)
        await indexAll(storage, "thr_1", [turnVector("thr_1", 1), turnVector("thr_1", 2)], {
          complete: false,
        })

        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: false, fromSeq: 3 })
        expect(await threadsToIndex(storage, configuration, 10)).toEqual(["thr_1"])
      })
    })

    test("a fork takes the turns of what it copies, current when the source was", async () => {
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 2)
        await indexAll(storage, "thr_1", [turnVector("thr_1", 1), turnVector("thr_1", 2)])

        await storage.agents.threads.fork({
          projectId,
          sourceThreadId: "thr_1",
          id: "thr_fork",
          ownerPrincipal: alice,
          createdAt: at(50),
        })

        const { messages } = await storage.agents.messages.list({ projectId, threadId: "thr_fork" })
        const copied = await storage.agents.turnVectors.list({ projectId, threadId: "thr_fork" })
        expect(copied.map((vector) => [vector.messageId, vector.firstSeq, vector.text])).toEqual([
          [messages[0]!.id, 1, "Question 1\n\nAnswer 1"],
          [messages[2]!.id, 3, "Question 2\n\nAnswer 2"],
        ])
        expect(copied[0]!.embedding).toEqual(vectorA)
        expect(await progressOf(storage, "thr_fork")).toMatchObject({ current: true, fromSeq: 3 })
        // The source keeps its own.
        expect(await listed(storage, "thr_1")).toEqual(["thr_1_q1#0", "thr_1_q2#0"])

        // A source indexed short of its end gives a fork that goes on from the same turn.
        await ask(storage, "thr_1", 3, 60)
        await storage.agents.threads.fork({
          projectId,
          sourceThreadId: "thr_1",
          id: "thr_fork_2",
          ownerPrincipal: alice,
          createdAt: at(70),
        })
        expect(await progressOf(storage, "thr_fork_2")).toMatchObject({
          current: false,
          fromSeq: 3,
        })
      })
    })

    test("another configuration's vectors are stale, and the first write for it drops them", async () => {
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 2)
        await indexAll(storage, "thr_1", [turnVector("thr_1", 1), turnVector("thr_1", 2)])

        expect(await progressOf(storage, "thr_1", otherConfiguration)).toMatchObject({
          current: false,
          fromSeq: 1,
        })
        expect(await threadsToIndex(storage, otherConfiguration, 10)).toEqual(["thr_1"])

        const progress = await progressOf(storage, "thr_1", otherConfiguration)
        await storage.agents.turnVectors.write({
          projectId,
          threadId: "thr_1",
          configuration: otherConfiguration,
          revision: progress!.revision,
          fromSeq: 1,
          turns: [turnVector("thr_1", 1, { embedding: vectorB })],
          complete: false,
        })

        const vectors = await storage.agents.turnVectors.list({ projectId, threadId: "thr_1" })
        expect(vectors.map((vector) => [vector.messageId, vector.configuration])).toEqual([
          ["thr_1_q1", otherConfiguration],
        ])
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: false, fromSeq: 1 })
      })
    })

    test("lists idle conversations behind, the most recently active first", async () => {
      await withStorage(async (storage) => {
        await conversation(storage, "thr_old", 1, 0)
        await conversation(storage, "thr_new", 1, 100)
        await conversation(storage, "thr_done", 1, 200)
        await indexAll(storage, "thr_done", [turnVector("thr_done", 1)])

        // A turn holds this one, and its child's thread is a sub-agent's: neither is listed.
        await busyConversationWithChild(storage)

        expect(await threadsToIndex(storage, configuration, 10)).toEqual(["thr_new", "thr_old"])
        expect(await threadsToIndex(storage, configuration, 1)).toEqual(["thr_new"])

        // Each comes with the revision it is at, which the job asking for it names.
        const [newest] = await storage.agents.turnVectors.listThreadsToIndex({
          projectId,
          configuration,
          limit: 1,
        })
        expect(newest!.revision).toBe((await progressOf(storage, "thr_new"))!.revision)
        expect(await progressOf(storage, "thr_missing")).toBeNull()
      })
    })

    test("a deferred thread leaves the list until then, and a write ends the deferral", async () => {
      // Guard proof: drop the deferral filter from listThreadsToIndex; the deferred thread is listed.
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 1)
        await conversation(storage, "thr_2", 1, 100)

        // No index yet: the deferral starts the thread's state, under the configuration given.
        const defer = (until: Date, failed: boolean) =>
          storage.agents.turnVectors.defer({
            projectId,
            threadId: "thr_1",
            configuration,
            until,
            failed,
          })
        await defer(at(600), true)
        await defer(at(900), true)
        await defer(at(1200), false)

        expect(await progressOf(storage, "thr_1")).toMatchObject({
          current: false,
          fromSeq: 1,
          failures: 2,
          deferredUntil: at(1200),
        })
        const listedAt = async (seconds: number) =>
          (
            await storage.agents.turnVectors.listThreadsToIndex({
              projectId,
              configuration,
              limit: 10,
              now: at(seconds),
            })
          ).map((thread) => thread.threadId)
        expect(await listedAt(1199)).toEqual(["thr_2"])
        expect(await listedAt(1200)).toEqual(["thr_2", "thr_1"])

        await indexAll(storage, "thr_1", [turnVector("thr_1", 1)])
        const progress = await progressOf(storage, "thr_1")
        expect(progress).toMatchObject({ current: true, failures: 0 })
        expect(progress!.deferredUntil).toBeUndefined()

        // A deferral keeps an existing index's configuration: under another, it stays behind.
        await storage.agents.turnVectors.defer({
          projectId,
          threadId: "thr_1",
          configuration: otherConfiguration,
          until: at(60),
          failed: false,
        })
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: true })
        expect(await progressOf(storage, "thr_1", otherConfiguration)).toMatchObject({
          current: false,
        })

        const missing = await storage.agents.turnVectors
          .defer({ projectId, threadId: "thr_missing", configuration, until: at(1), failed: true })
          .catch((caught: unknown) => caught)
        expect((missing as AgentStorageError).code).toBe("thread_not_found")
      })
    })

    test("a halted thread leaves the list until it or the configuration changes", async () => {
      // Guard proof: drop the halted filter from listThreadsToIndex; the halted thread is listed.
      // Drop `indexed_revision = NULL` from halt; a thread indexed under one configuration reads
      // as current under the one that failed.
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 1)
        const halt = async (threadId: string, config = configuration) =>
          storage.agents.turnVectors.halt({
            projectId,
            threadId,
            configuration: config,
            revision: (await progressOf(storage, threadId, config))!.revision,
          })

        expect(await halt("thr_1")).toBe(true)
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: false, halted: true })
        expect(await threadsToIndex(storage, configuration, 10)).toEqual([])
        expect(await progressOf(storage, "thr_1", otherConfiguration)).toMatchObject({
          halted: false,
        })
        expect(await threadsToIndex(storage, otherConfiguration, 10)).toEqual(["thr_1"])

        // Not once the thread moved: the change asks again.
        const before = await progressOf(storage, "thr_1")
        await ask(storage, "thr_1", 2, 20)
        expect(await progressOf(storage, "thr_1")).toMatchObject({ halted: false })
        expect(await threadsToIndex(storage, configuration, 10)).toEqual(["thr_1"])
        expect(
          await storage.agents.turnVectors.halt({
            projectId,
            threadId: "thr_1",
            configuration,
            revision: before!.revision,
          })
        ).toBe(false)

        // A write lifts it.
        await halt("thr_1")
        await indexAll(storage, "thr_1", [turnVector("thr_1", 1), turnVector("thr_1", 2)])
        expect(await progressOf(storage, "thr_1")).toMatchObject({ current: true, halted: false })

        // Halting under another configuration leaves nothing current under it.
        await halt("thr_1", otherConfiguration)
        expect(await progressOf(storage, "thr_1", otherConfiguration)).toMatchObject({
          current: false,
          halted: true,
        })
        expect(await threadsToIndex(storage, otherConfiguration, 10)).toEqual([])
        expect(
          await storage.agents.turnVectors.halt({
            projectId,
            threadId: "thr_missing",
            configuration,
            revision: 0,
          })
        ).toBe(false)
      })
    })

    test("refuses a turn that opens before the seq it replaces from", async () => {
      await withStorage(async (storage) => {
        await conversation(storage, "thr_1", 2)
        const error = await indexAll(storage, "thr_1", [turnVector("thr_1", 1)], {
          fromSeq: 3,
        }).catch((caught: unknown) => caught)

        expect(error).toBeInstanceOf(AgentStorageError)
        expect((error as AgentStorageError).code).toBe("invalid_input")
        expect(await listed(storage, "thr_1")).toEqual([])
      })
    })

    describe.if(options.searches ?? true)("search", () => {
      test("reads the conversations a principal owns or was added to, within the scope", async () => {
        // Guard proof: drop the participant branch of the eligible conversations; `thr_added` is
        // never found. Drop the shared-scope filter; Alice's private `thr_mine` is found from a
        // shared conversation.
        await withStorage(async (storage) => {
          await ownedBy(storage, "thr_mine", alice)
          await ownedBy(storage, "thr_mine_shared", alice, [bob])
          await ownedBy(storage, "thr_added", bob, [alice])
          await ownedBy(storage, "thr_bobs", bob)
          await ownedBy(storage, "thr_bob_and_carol", bob, [carol])
          for (const threadId of [
            "thr_mine",
            "thr_mine_shared",
            "thr_added",
            "thr_bobs",
            "thr_bob_and_carol",
          ]) {
            await indexTurns(storage, threadId, [{ seconds: 10, chunks: [east] }])
          }

          expect(await threadsFound(storage)).toEqual(["thr_added", "thr_mine", "thr_mine_shared"])
          expect(await threadsFound(storage, { scope: "shared" })).toEqual([
            "thr_added",
            "thr_mine_shared",
          ])
          expect(await threadsFound(storage, { principal: carol })).toEqual(["thr_bob_and_carol"])
          expect(await threadsFound(storage, { principal: bob, scope: "shared" })).toEqual([
            "thr_added",
            "thr_bob_and_carol",
            "thr_mine_shared",
          ])

          // The conversation a run works for is left out.
          expect(await threadsFound(storage, { excludeThreadId: "thr_mine" })).toEqual([
            "thr_added",
            "thr_mine_shared",
          ])

          // Code without a caller reads every conversation.
          expect(await threadsFound(storage, { principal: undefined })).toEqual([
            "thr_added",
            "thr_bob_and_carol",
            "thr_bobs",
            "thr_mine",
            "thr_mine_shared",
          ])
        })
      })

      test("never reads a sub-agent's thread", async () => {
        // Guard proof: drop `kind = 'conversation'` from the eligible conversations; the child's
        // task is found, as its thread's owner is the conversation's.
        await withStorage(async (storage) => {
          await busyConversationWithChild(storage)
          const progress = await progressOf(storage, "thr_child")
          await storage.agents.turnVectors.write({
            projectId,
            threadId: "thr_child",
            configuration,
            revision: progress!.revision,
            fromSeq: 1,
            turns: [
              {
                messageId: "child_task",
                chunk: 0,
                firstSeq: 1,
                lastSeq: 1,
                turnAt: at(320),
                text: "Research.",
                embedding: east,
              },
            ],
            complete: true,
          })

          expect(
            await storage.agents.turnVectors.list({ projectId, threadId: "thr_child" })
          ).toHaveLength(1)
          expect(await found(storage)).toEqual([])
          expect(await found(storage, { principal: undefined })).toEqual([])
        })
      })

      test("reads only turns opened within the window, of the configuration and its dimension", async () => {
        // Guard proof: make `until` inclusive; `until: at(30)` finds turn 3 as well.
        await withStorage(async (storage) => {
          await ownedBy(storage, "thr_mine", alice)
          await indexTurns(storage, "thr_mine", [
            { seconds: 10, chunks: [east] },
            { seconds: 20, chunks: [east] },
            { seconds: 30, chunks: [east] },
          ])

          expect(await found(storage, { since: at(20) })).toEqual([
            "thr_mine_q3#0",
            "thr_mine_q2#0",
          ])
          expect(await found(storage, { until: at(30) })).toEqual([
            "thr_mine_q2#0",
            "thr_mine_q1#0",
          ])
          expect(await found(storage, { since: at(20), until: at(30) })).toEqual(["thr_mine_q2#0"])
          expect(await found(storage, { since: at(20), until: at(20) })).toEqual([])

          // Another model's vectors, and vectors of another length, are never compared.
          await ownedBy(storage, "thr_other_model", alice)
          await indexTurns(
            storage,
            "thr_other_model",
            [{ seconds: 40, chunks: [east] }],
            otherConfiguration
          )
          await ownedBy(storage, "thr_wider", alice)
          await indexTurns(storage, "thr_wider", [{ seconds: 40, chunks: [[1, 0, 0, 0]] }])

          expect(await threadsFound(storage)).toEqual(["thr_mine"])
          expect(
            await found(storage, { configuration: otherConfiguration, since: at(40) })
          ).toEqual(["thr_other_model_q1#0"])
        })
      })

      test("ranks turns by their best chunk, keeping a few of each conversation", async () => {
        // Guard proof: rank chunks instead of turns; turn 1 of `thr_a` is found twice. Drop the
        // per-conversation bound; `thr_a`'s weaker turns crowd out what is asked for.
        await withStorage(async (storage) => {
          await ownedBy(storage, "thr_a", alice)
          await indexTurns(storage, "thr_a", [
            { seconds: 10, chunks: [north, east] },
            { seconds: 20, chunks: [east] },
            { seconds: 30, chunks: [northeast] },
            { seconds: 40, chunks: [west] },
          ])
          await ownedBy(storage, "thr_b", alice)
          await indexTurns(storage, "thr_b", [
            { seconds: 20, chunks: [east] },
            { seconds: 50, chunks: [east, east] },
          ])

          // Equal scores: the most recent first, then by conversation.
          const { hits } = await search(storage)
          expect(hits.map((hit) => `${hit.messageId}#${hit.chunk}`)).toEqual([
            "thr_b_q2#0",
            "thr_a_q2#0",
            "thr_b_q1#0",
            "thr_a_q1#1",
            "thr_a_q3#0",
            "thr_a_q4#0",
          ])
          expect(hits.map((hit) => Number(hit.score.toFixed(5)))).toEqual([1, 1, 1, 1, 0.6, -1])
          expect(hits[3]).toMatchObject({
            threadId: "thr_a",
            firstSeq: 1,
            lastSeq: 2,
            turnAt: at(10),
            text: "Turn 1 of thr_a, part 1",
          })

          expect(await found(storage, { perThread: 2 })).toEqual([
            "thr_b_q2#0",
            "thr_a_q2#0",
            "thr_b_q1#0",
            "thr_a_q1#1",
          ])
          expect(await found(storage, { perThread: 2, k: 3 })).toEqual([
            "thr_b_q2#0",
            "thr_a_q2#0",
            "thr_b_q1#0",
          ])
        })
      })

      test("scores the most recent chunks within its bound, and says from when", async () => {
        // Guard proof: cut the window at the bound itself; turn 2's second chunk is never scored,
        // neither by this search nor by the one asking before `searchedFrom`.
        await withStorage(async (storage) => {
          await ownedBy(storage, "thr_mine", alice)
          await indexTurns(storage, "thr_mine", [
            { seconds: 10, chunks: [north] },
            { seconds: 20, chunks: [north, east] },
            { seconds: 30, chunks: [north] },
          ])

          const everything = await search(storage)
          expect(everything.hits).toHaveLength(3)
          expect(everything.searchedFrom).toBeUndefined()

          // Two chunks: turn 3 alone, since turn 2 does not fit whole.
          const newest = await search(storage, { candidates: 2 })
          expect(newest.hits.map((hit) => hit.messageId)).toEqual(["thr_mine_q3"])
          expect(newest.searchedFrom).toEqual(at(30))

          const before = await search(storage, { candidates: 2, until: newest.searchedFrom })
          expect(before.hits.map((hit) => `${hit.messageId}#${hit.chunk}`)).toEqual([
            "thr_mine_q2#1",
          ])
          expect(before.searchedFrom).toEqual(at(20))

          const oldest = await search(storage, { candidates: 2, until: before.searchedFrom })
          expect(oldest.hits.map((hit) => hit.messageId)).toEqual(["thr_mine_q1"])
          expect(oldest.searchedFrom).toBeUndefined()

          // More chunks at one instant than the bound: the first ones, and the search goes on
          // from before it.
          await ownedBy(storage, "thr_long", alice)
          await indexTurns(storage, "thr_long", [{ seconds: 40, chunks: [north, north, east] }])
          const crowded = await search(storage, { candidates: 2 })
          expect(crowded.hits.map((hit) => `${hit.messageId}#${hit.chunk}`)).toEqual([
            "thr_long_q1#0",
          ])
          expect(crowded.searchedFrom).toEqual(at(40))
        })
      })

      test("refuses more candidates than one search may score, and a window closed before it opens", async () => {
        await withStorage(async (storage) => {
          for (const input of [
            { candidates: 10_001 },
            { since: at(20), until: at(10) },
            { k: 0 },
            { vector: [0, 0, 0] },
          ]) {
            const error = await search(storage, input).catch((caught: unknown) => caught)
            expect(error).toBeInstanceOf(AgentStorageError)
            expect((error as AgentStorageError).code).toBe("invalid_input")
          }
        })
      })
    })

    test("answers whether it can search what it keeps", async () => {
      await withStorage(async (storage) => {
        expect(typeof (await storage.agents.turnVectors.searchAvailable())).toBe("boolean")
      })
    })
  })
}
