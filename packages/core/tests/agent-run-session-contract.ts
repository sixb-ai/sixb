import { describe, expect, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage, type SecurityDefinitionCatalog } from "../src"
import {
  AgentExecutionLostError,
  type AgentRunSession,
  type claimAgentRun,
  createSubagentRunId,
  createSubagentThreadId,
  NOOP_STREAM_SINK,
  publishAgentRunCancel,
} from "../src/agents"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestAgentExecution } from "../src/testing"

// What every run session does, however its runner reaches it: in process, as the worker's does,
// or over HTTP. An implementation runs the suite with how it claims a run; the suite seeds storage
// and checks the session against it.

/** How an implementation claims a run and opens its session. */
export type ClaimAgentRunSession = typeof claimAgentRun

const PROJECT_ID = "agent-run-session-contract"
const LEASE = "2099-01-01T00:00:00.000Z"
/** A lease already run out: what lets another runner take a run over. */
const LAPSED = "2000-01-01T00:00:00.000Z"

/** A queued turn in a fresh storage, with the host a session works against. */
export async function seedAgentRun(id = "run-1") {
  const storage = new InMemoryStorage()
  const broker = new InMemoryBroker()
  await storage.agents.threads.create({
    id: `thread-${id}`,
    projectId: PROJECT_ID,
    ownerPrincipal: { type: "system", id: "system" },
  })
  const executionId = await createTestAgentExecution(storage, { projectId: PROJECT_ID, runId: id })
  const run = await storage.agents.runs.create({
    id,
    projectId: PROJECT_ID,
    executionId,
    threadId: `thread-${id}`,
    triggerMessageId: `message-${id}`,
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  const host = {
    projectId: PROJECT_ID,
    storage,
    broker,
    recoverAiModelCall: async () => {},
    events: NOOP_STREAM_SINK,
    security: { groups: [], roles: [] } as unknown as SecurityDefinitionCatalog,
  }
  return { storage, broker, run, host }
}

/** A child the turn spawned, queued in its own thread. */
async function spawnChild(storage: InMemoryStorage, turn: AgentRunSession) {
  const id = `${turn.run.id}-child`
  const executionId = await createTestAgentExecution(storage, {
    projectId: PROJECT_ID,
    runId: id,
    sourceExecutionId: turn.run.executionId,
  })
  return storage.agents.runs.createSubagent({
    id,
    projectId: PROJECT_ID,
    executionId,
    parentRunId: turn.run.id,
    parentExecutionToken: turn.executionToken,
    spawnKey: "west",
    spec: {
      model: { provider: "test", modelId: "test-model" },
      task: "Look west.",
      toolNames: [],
      maxSteps: 5,
    },
    thread: { id: `${id}-thread`, create: true },
    trigger: { id: `${id}-task`, parts: [{ type: "text", text: "Look west." }] },
    maxActiveChildren: 4,
  })
}

const alice = { type: "user", id: "usr_alice" } as const

// The project's roles, as the worker's host resolves them: one lets its group use the Agent.
const RUNNERS = "agent-users"
const SECURITY = {
  listResolvedRoles: () => [
    {
      id: "agent.runner",
      grantedToGroupIds: [RUNNERS],
      grants: { ...emptyGrantIndex(), "run:agent": true },
    },
  ],
} as unknown as SecurityDefinitionCatalog

/** A conversation owned by Alice, with turns to claim. */
async function seedConversation(claim: ClaimAgentRunSession) {
  const storage = new InMemoryStorage()
  const host = {
    projectId: PROJECT_ID,
    storage,
    broker: new InMemoryBroker(),
    recoverAiModelCall: async () => {},
    events: NOOP_STREAM_SINK,
    security: SECURITY,
  }
  await storage.auth.users.create({
    projectId: PROJECT_ID,
    id: alice.id,
    email: "alice@example.com",
    displayName: "Alice",
  })
  const thread = await storage.agents.threads.create({
    id: "thr_1",
    projectId: PROJECT_ID,
    ownerPrincipal: alice,
  })
  const say = (id: string, role: "user" | "assistant", runId: string | null = null) =>
    storage.agents.messages.append({
      id,
      projectId: PROJECT_ID,
      threadId: thread.id,
      runId,
      role,
      ...(role === "user" ? { authorPrincipal: alice } : {}),
      parts: [{ type: "text", text: id }],
    })
  /** A turn of the thread, answering `trigger`; claimed, it opens its session. */
  const turn = async (id: string, trigger: string, timeZone?: string) => {
    const executionId = await createTestAgentExecution(storage, {
      projectId: PROJECT_ID,
      runId: id,
    })
    return storage.agents.runs.create({
      id,
      projectId: PROJECT_ID,
      executionId,
      threadId: thread.id,
      triggerMessageId: trigger,
      spec: {
        model: { provider: "test", modelId: "test-model" },
        ...(timeZone ? { timeZone } : {}),
      },
    })
  }
  const open = async (run: Awaited<ReturnType<typeof turn>>) => {
    const session = await claim(host, { run, leaseExpiresAt: LEASE })
    if (!session) throw new Error("Expected the run to be claimed.")
    return session
  }
  return { storage, thread, say, turn, open }
}

export function describeAgentRunSessionContract(claim: ClaimAgentRunSession): void {
  describe("claiming a run", () => {
    test("starts a queued run with a fresh execution token", async () => {
      const { host, run } = await seedAgentRun()

      const session = await claim(host, { run, leaseExpiresAt: LEASE })

      expect(session?.run.status).toBe("running")
      expect(session?.executionToken).toBe(session?.run.execution?.token)
      session?.close()
    })

    test("returns nothing for a run that already ended", async () => {
      const { host, storage, run } = await seedAgentRun()
      const ended = await storage.agents.runs.finishQueued({
        projectId: PROJECT_ID,
        id: run.id,
        status: "cancelled",
      })

      expect(await claim(host, { run: ended, leaseExpiresAt: LEASE })).toBeNull()
    })

    // Guard proof: let `runs.start`'s invalid_state through in startOrReclaim; the claim throws.
    test("returns nothing for a queued run that ended since it was read", async () => {
      const { host, storage, run } = await seedAgentRun()
      await storage.agents.runs.finishQueued({
        projectId: PROJECT_ID,
        id: run.id,
        status: "cancelled",
      })

      expect(await claim(host, { run, leaseExpiresAt: LEASE })).toBeNull()
    })
    // Removal proof: drop `ifLapsedBy` from startOrReclaim's reclaim; the second claim takes over a
    // run whose runner still renews its lease.
    test("leaves a run whose lease has not lapsed to its runner", async () => {
      const { host, run } = await seedAgentRun()
      const first = await claim(host, { run, leaseExpiresAt: LEASE })
      if (!first) throw new Error("Expected the run to be claimed.")

      expect(await claim(host, { run: first.run, leaseExpiresAt: LEASE })).toBeNull()
      expect((await first.finish({ status: "succeeded" })).status).toBe("succeeded")
      first.close()
    })

    // Removal proof: rethrow in renewLease without aborting `cancelled`; the earlier runner keeps
    // calling its model until its next write.
    test("a renewal that finds the run taken over stops its runner", async () => {
      const { host, run } = await seedAgentRun()
      const first = await claim(host, { run, leaseExpiresAt: LAPSED })
      if (!first) throw new Error("Expected the run to be claimed.")
      const second = await claim(host, { run: first.run, leaseExpiresAt: LEASE })
      if (!second) throw new Error("Expected the run to be reclaimed.")

      expect(await first.renewLease(LEASE).catch((error) => error)).toBeInstanceOf(
        AgentExecutionLostError
      )
      expect(first.cancelled.reason).toBeInstanceOf(AgentExecutionLostError)
      expect(second.cancelled.aborted).toBe(false)
      first.close()
      second.close()
    })

    // The fence the whole session rests on. Return the running run unchanged in startOrReclaim, in
    // place of `runs.reclaim`; the token never rotates and the earlier session keeps writing.
    test("a reclaim fences the earlier session out of every write", async () => {
      const { host, run } = await seedAgentRun()
      const first = await claim(host, { run, leaseExpiresAt: LAPSED })
      if (!first) throw new Error("Expected the run to be claimed.")
      const second = await claim(host, { run: first.run, leaseExpiresAt: LEASE })
      if (!second) throw new Error("Expected the run to be reclaimed.")

      expect(second.executionToken).not.toBe(first.executionToken)
      expect(await first.finish({ status: "succeeded" }).catch((error) => error)).toBeInstanceOf(
        AgentExecutionLostError
      )
      expect(await first.renewLease(LEASE).catch((error) => error)).toBeDefined()
      expect((await second.finish({ status: "succeeded" })).status).toBe("succeeded")
      first.close()
      second.close()
    })
  })

  describe("an agent run session", () => {
    test("finishes with what the run did, in one transaction", async () => {
      const { host, storage, run } = await seedAgentRun()
      const session = await claim(host, { run, leaseExpiresAt: LEASE })
      if (!session) throw new Error("Expected the run to be claimed.")

      const finished = await session.finish({ status: "succeeded", finishReason: "stop" }, [
        {
          id: "message-answer",
          projectId: PROJECT_ID,
          threadId: run.threadId,
          runId: run.id,
          role: "assistant",
          parts: [{ type: "text", text: "Done." }],
        },
      ])

      expect(finished).toMatchObject({ status: "succeeded", finishReason: "stop" })
      const messages = await storage.agents.messages.list({
        projectId: PROJECT_ID,
        threadId: run.threadId,
      })
      expect(messages.messages.map((message) => message.id)).toContain("message-answer")
      session.close()
    })

    test("is cancelled with its own run, and with a run named in cancelWith", async () => {
      const { host, broker, run } = await seedAgentRun()
      const session = await claim(host, {
        run,
        leaseExpiresAt: LEASE,
        cancelWith: ["parent-run"],
      })
      if (!session) throw new Error("Expected the run to be claimed.")
      const cancelled = new Promise<void>((resolve) =>
        session.cancelled.addEventListener("abort", () => resolve(), { once: true })
      )

      await publishAgentRunCancel(broker, { projectId: PROJECT_ID, runId: "parent-run" })

      await cancelled
      expect(session.cancelled.aborted).toBe(true)
      session.close()
    })
  })

  describe("a cancel recorded on the run", () => {
    // Guard proof: drop readCancel from renewLease; the renewal returns and the session runs on.
    test("cancels the session at its next lease renewal, with no broker cancel", async () => {
      const { host, storage, run } = await seedAgentRun()
      const session = await claim(host, { run, leaseExpiresAt: LEASE })
      if (!session) throw new Error("Expected the run to be claimed.")

      await storage.agents.runs.requestCancel({ projectId: PROJECT_ID, id: run.id })
      expect(session.cancelled.aborted).toBe(false)
      await session.renewLease(LEASE)

      expect(session.cancelled.aborted).toBe(true)
      session.close()
    })

    // Guard proof: drop readCancel(run) from openAgentRunSession; the reclaimed session runs on.
    test("cancels a session claimed after it", async () => {
      const { host, storage, run } = await seedAgentRun()
      const first = await claim(host, { run, leaseExpiresAt: LAPSED })
      if (!first) throw new Error("Expected the run to be claimed.")
      first.close()
      const asked = await storage.agents.runs.requestCancel({ projectId: PROJECT_ID, id: run.id })

      const second = await claim(host, { run: asked, leaseExpiresAt: LEASE })

      expect(second?.cancelled.aborted).toBe(true)
      second?.close()
    })
  })

  describe("an agent run session's children and mail", () => {
    // Clearing a dead attempt deletes messages from a child's thread: a turn reclaimed by another
    // delivery must not. Drop the fence clearAttempt passes deleteByRunId; it deletes.
    test("clears a child's dead attempt only while the turn owns its run", async () => {
      const { host, storage, run } = await seedAgentRun()
      const first = await claim(host, { run, leaseExpiresAt: LAPSED })
      if (!first) throw new Error("Expected the run to be claimed.")
      // A child's attempt that failed, and what it wrote.
      const attempt = await claim(host, {
        run: await spawnChild(storage, first),
        leaseExpiresAt: LEASE,
      })
      if (!attempt) throw new Error("Expected the child to be claimed.")
      await storage.agents.messages.append({
        id: "message-dead",
        projectId: PROJECT_ID,
        threadId: attempt.run.threadId,
        runId: attempt.run.id,
        role: "assistant",
        parts: [{ type: "text", text: "From a failed attempt." }],
      })
      await attempt.finish({ status: "failed" })
      attempt.close()
      const dead = { threadId: attempt.run.threadId, runId: attempt.run.id }
      const second = await claim(host, { run: first.run, leaseExpiresAt: LEASE })
      if (!second) throw new Error("Expected the run to be reclaimed.")

      const refused = await first.children.clearAttempt(dead).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(AgentExecutionLostError)
      expect(
        await storage.agents.messages.getById({ projectId: PROJECT_ID, id: "message-dead" })
      ).toBeDefined()

      await second.children.clearAttempt(dead)
      expect(
        await storage.agents.messages.getById({ projectId: PROJECT_ID, id: "message-dead" })
      ).toBeNull()
      first.close()
      second.close()
    })

    // Compaction's checkpoint is the one write a run makes to its conversation besides finishing.
    // Write it with the token storage holds now in place of the session's; the stale write lands.
    test("writes a context checkpoint only while the turn owns its run", async () => {
      const { host, run } = await seedAgentRun()
      const first = await claim(host, { run, leaseExpiresAt: LAPSED })
      if (!first) throw new Error("Expected the run to be claimed.")
      const checkpoint = (id: string) => ({
        id,
        threadId: run.threadId,
        expectedPreviousCheckpointId: null,
        expectedHeadSeq: 2,
        reason: "threshold" as const,
        summary: "Earlier turns.",
        summaryFormatVersion: 1 as const,
        summarizedThroughSeq: 1,
        observedHeadSeq: 2,
        estimatedInputTokensBefore: 10,
        estimatedInputTokensAfter: 5,
        summaryModelId: "test-model",
      })
      await host.storage.agents.messages.append({
        id: "message-earlier",
        projectId: PROJECT_ID,
        threadId: run.threadId,
        runId: run.id,
        role: "assistant",
        parts: [{ type: "text", text: "An earlier answer." }],
      })
      await host.storage.agents.messages.append({
        id: "message-head",
        projectId: PROJECT_ID,
        threadId: run.threadId,
        runId: run.id,
        role: "user",
        parts: [{ type: "text", text: "The latest question." }],
      })
      const second = await claim(host, { run: first.run, leaseExpiresAt: LEASE })
      if (!second) throw new Error("Expected the run to be reclaimed.")

      expect(
        await first.checkpoint(checkpoint("ckpt-stale")).catch((error: unknown) => error)
      ).toBeInstanceOf(AgentExecutionLostError)
      expect((await second.checkpoint(checkpoint("ckpt-1"))).checkpoint?.id).toBe("ckpt-1")
      // A run that ended holds nothing either: the same error, not storage's own.
      await second.finish({ status: "succeeded" })
      expect(
        await second.checkpoint(checkpoint("ckpt-2")).catch((error: unknown) => error)
      ).toBeInstanceOf(AgentExecutionLostError)
      first.close()
      second.close()
    })

    // Guard proof: drop the scope checks from agentRunThreads and agentRunChildren; the turn reads
    // the other conversation's message, thread and run.
    test("reads only its own conversation: its thread, its children's, and their runs", async () => {
      const { host, storage, run } = await seedAgentRun()
      // Another conversation of the project: its thread, message and run.
      await storage.agents.threads.create({
        id: "thread-other",
        projectId: PROJECT_ID,
        ownerPrincipal: { type: "system", id: "system" },
      })
      const otherExecution = await createTestAgentExecution(storage, {
        projectId: PROJECT_ID,
        runId: "run-other",
      })
      const otherRun = await storage.agents.runs.create({
        id: "run-other",
        projectId: PROJECT_ID,
        executionId: otherExecution,
        threadId: "thread-other",
        triggerMessageId: "message-other",
        spec: { model: { provider: "test", modelId: "test-model" } },
      })
      const secret = await storage.agents.messages.append({
        id: "message-other",
        projectId: PROJECT_ID,
        threadId: "thread-other",
        runId: null,
        role: "user",
        parts: [{ type: "text", text: "Not yours." }],
      })
      const session = await claim(host, { run, leaseExpiresAt: LEASE })
      if (!session) throw new Error("Expected the run to be claimed.")
      const child = await spawnChild(storage, session)

      expect(await session.threads.message(secret.id)).toBeNull()
      expect(
        await session.threads
          .messages({ threadId: otherRun.threadId })
          .catch((error: unknown) => error)
      ).toBeInstanceOf(Error)
      expect(await session.children.get(otherRun.id)).toBeNull()
      expect((await session.children.getMany([otherRun.id, child.id])).map((r) => r.id)).toEqual([
        child.id,
      ])
      expect((await session.threads.messages({ threadId: child.threadId })).messages).toHaveLength(
        1
      )
      expect((await session.children.get(run.id))?.id).toBe(run.id)
      session.close()
    })

    test("sends as its run to a child's thread, and reads it back from a cursor", async () => {
      const { host, storage, run } = await seedAgentRun()
      const session = await claim(host, { run, leaseExpiresAt: LEASE })
      if (!session) throw new Error("Expected the run to be claimed.")
      const child = await claim(host, {
        run: await spawnChild(storage, session),
        leaseExpiresAt: LEASE,
        cancelWith: [run.id],
      })
      if (!child) throw new Error("Expected the child to be claimed.")
      const inbox = { threadId: child.run.threadId }
      const mail = (id: string) =>
        ({ id, toThreadId: child.run.threadId, kind: "message", text: id }) as const

      await session.mail.send(mail("first"))
      const page = await child.mail.read(inbox)
      await session.mail.send(mail("second"))
      const next = await child.mail.read(inbox, page.cursor)

      expect(page.mail).toMatchObject([{ id: "first", fromRunId: run.id }])
      expect(next.mail.map((item) => item.id)).toEqual(["second"])
      session.close()
      child.close()
    })
    // Removal proof: store the runner's execution, id and limit as it sends them in
    // agentRunChildren.spawn; a runner could hand its child any authority, or any run's id.
    test("spawns a child as the turn: its id and thread by its key, its authority the turn's", async () => {
      const { host, storage, run } = await seedAgentRun()
      const turn = await claim({ ...host, maxActiveChildren: 1 }, { run, leaseExpiresAt: LEASE })
      if (!turn) throw new Error("Expected the run to be claimed.")
      const draft = (spawnKey: string) => ({
        spawnKey,
        spec: {
          model: { provider: "test", modelId: "test-model" },
          task: `Look ${spawnKey}.`,
          toolNames: [],
          maxSteps: 5,
        },
        thread: { create: true } as const,
        trigger: { id: `${spawnKey}-task`, parts: [{ type: "text" as const, text: "Look." }] },
      })

      const child = await turn.children.spawn(draft("west"))

      expect(child).toMatchObject({
        id: createSubagentRunId(run.id, "west"),
        threadId: createSubagentThreadId(run.id, "west"),
        parentRunId: run.id,
      })
      const [turnExecution, childExecution] = await Promise.all(
        [run.executionId, child.executionId].map((id) =>
          storage.executions.getById({ projectId: PROJECT_ID, id })
        )
      )
      expect(childExecution).toMatchObject({
        executor: { type: "agent", runId: child.id },
        source: { type: "execution", executionId: run.executionId },
        authorizationRef: turnExecution?.authorizationRef,
      })
      // The host's limit, not the runner's.
      expect(await turn.children.spawn(draft("east")).catch((error) => error)).toMatchObject({
        code: "active_child_limit",
      })
      turn.close()
    })

    // Removal proof: drop ownInbox in agentRunMail, or the attempt check in clearAttempt; a runner
    // reads another run's mail, or deletes what a live child wrote.
    test("hears only its own inbox, and clears only a child's ended attempt", async () => {
      const { host, storage, run } = await seedAgentRun()
      const turn = await claim(host, { run, leaseExpiresAt: LEASE })
      if (!turn) throw new Error("Expected the run to be claimed.")
      const spawned = await spawnChild(storage, turn)
      const child = await claim(host, { run: spawned, leaseExpiresAt: LEASE, cancelWith: [run.id] })
      if (!child) throw new Error("Expected the child to be claimed.")

      expect(await turn.mail.read({ runId: run.id })).toMatchObject({ mail: [] })
      expect(await child.mail.read({ threadId: spawned.threadId })).toMatchObject({ mail: [] })
      expect(() => turn.mail.read({ threadId: spawned.threadId })).toThrow("its own inbox")
      expect(() => child.mail.read({ runId: run.id })).toThrow("its own inbox")
      expect(() => turn.mail.read({ runId: "another-run" })).toThrow("its own inbox")
      expect(
        await turn.children
          .clearAttempt({ threadId: spawned.threadId, runId: spawned.id })
          .catch((error: unknown) => error)
      ).toBeInstanceOf(Error)
      expect(
        await turn.children
          .clearAttempt({ threadId: spawned.threadId, runId: "another-run" })
          .catch((error: unknown) => error)
      ).toBeInstanceOf(Error)
      turn.close()
      child.close()
    })

    // Guard proof: drop the recipient checks from agentRunMail's send; the turn mails its own thread
    // and the child mails a run that is not its parent. Drop the ownership read; the stale turn sends.
    test("mails only its own children or parent, and nothing once it lost its run", async () => {
      const { host, storage, run } = await seedAgentRun()
      const turn = await claim(host, { run, leaseExpiresAt: LAPSED })
      if (!turn) throw new Error("Expected the run to be claimed.")
      const spawned = await spawnChild(storage, turn)
      const child = await claim(host, {
        run: spawned,
        leaseExpiresAt: LEASE,
        cancelWith: [run.id],
      })
      if (!child) throw new Error("Expected the child to be claimed.")
      const message = { id: "m", kind: "message", text: "Hi." } as const

      expect(
        await turn.mail.send({ ...message, toThreadId: run.threadId }).catch((error) => error)
      ).toBeInstanceOf(Error)
      expect(
        await child.mail.send({ ...message, toRunId: "another-run" }).catch((error) => error)
      ).toBeInstanceOf(Error)
      await child.mail.send({ id: "q", kind: "question", text: "Which?", toRunId: run.id })
      expect((await turn.mail.read({ runId: run.id })).mail).toMatchObject([
        { id: "q", fromRunId: spawned.id, fromThreadId: spawned.threadId },
      ])

      const reclaimed = await claim(host, { run: turn.run, leaseExpiresAt: LEASE })
      expect(
        await turn.mail
          .send({ ...message, toThreadId: spawned.threadId })
          .catch((error: unknown) => error)
      ).toBeInstanceOf(AgentExecutionLostError)
      turn.close()
      child.close()
      reclaimed?.close()
    })
  })

  describe("a turn's context", () => {
    // Guard proof: return every participant from readReaders; Cleo and Dan, who cannot read the
    // thread, are then named to the model as taking part.
    test("names the participants who can read the thread now, and the people it names", async () => {
      const { storage, thread, say, turn, open } = await seedConversation(claim)
      const people = [
        { id: "usr_bob", status: "active", member: true, displayName: "Bob" },
        { id: "usr_cleo", status: "active", member: false, displayName: "Cleo" },
        { id: "usr_dan", status: "suspended", member: true, displayName: "Dan" },
      ] as const
      for (const person of people) {
        await storage.auth.users.create({
          projectId: PROJECT_ID,
          id: person.id,
          email: `${person.id}@example.com`,
          status: person.status,
          displayName: person.displayName,
        })
        if (person.member) {
          await storage.auth.groupMemberships.upsert({
            projectId: PROJECT_ID,
            userId: person.id,
            groupId: RUNNERS,
            source: "manual",
          })
        }
      }
      await storage.agents.threads.addParticipants({
        projectId: PROJECT_ID,
        threadId: thread.id,
        principals: people.map((person) => ({ type: "user", id: person.id })),
        addedBy: alice,
        maxParticipants: 50,
      })
      await say("msg_1", "user")
      const session = await open(await turn("run_1", "msg_1"))

      const context = await session.context()

      expect(context.participants).toHaveLength(3)
      expect(context.readers).toEqual([{ type: "user", id: "usr_bob" }])
      // Alice owns the thread and wrote in it; Bob reads it. Cleo and Dan are not named.
      expect(context.names).toEqual({ "user:usr_alice": "Alice", "user:usr_bob": "Bob" })
      session.close()
    })

    // Guard proof: drop the `seq > afterSeq` test from readUsageAnchor; the answer the checkpoint
    // already summarized anchors the estimate.
    test("anchors its history on the latest answer after the checkpoint, with its zone", async () => {
      const { storage, thread, say, turn, open } = await seedConversation(claim)
      await say("msg_1", "user")
      const first = await open(await turn("run_1", "msg_1", "Europe/Paris"))
      await say("msg_2", "assistant", "run_1")
      await storage.aiUsage.recordModelCall({
        id: "usage_1",
        projectId: PROJECT_ID,
        executionId: first.run.executionId,
        attempt: 1,
        callId: "call_1",
        requesterGroupIds: [],
        providerId: "test",
        requestedModelId: "test-model",
        responseId: "response_1",
        usage: { inputTokens: 100, outputTokens: 20 },
        occurredAt: new Date("2026-08-27T12:01:00.000Z"),
      })
      await first.finish({ status: "succeeded" })
      first.close()
      await say("msg_3", "user")
      const second = await open(await turn("run_2", "msg_3"))

      const { history } = await second.context()

      expect(history.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_3"])
      expect(history.sentTimeZones).toEqual({ msg_1: "Europe/Paris" })
      expect(history.usageAnchor).toMatchObject({
        messageId: "msg_2",
        modelCall: { id: "usage_1", usage: { inputTokens: 100, outputTokens: 20 } },
      })

      // An answer the checkpoint saw anchors nothing, even one it kept: its usage counted a request
      // that has since changed.
      await say("msg_4", "assistant", "run_1")
      const after = await second.checkpoint({
        id: "ckpt_1",
        threadId: thread.id,
        expectedPreviousCheckpointId: null,
        expectedHeadSeq: 4,
        reason: "threshold",
        summary: "Earlier turns.",
        summaryFormatVersion: 1,
        summarizedThroughSeq: 2,
        observedHeadSeq: 4,
        estimatedInputTokensBefore: 10,
        estimatedInputTokensAfter: 5,
        summaryModelId: "test-model",
      })
      expect(after.checkpoint?.id).toBe("ckpt_1")
      expect(after.messages.map((message) => message.id)).toEqual(["msg_3", "msg_4"])
      expect(after.usageAnchor).toBeUndefined()
      second.close()
    })
  })
}
