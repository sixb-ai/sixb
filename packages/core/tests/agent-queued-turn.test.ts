import { describe, expect, test } from "bun:test"
import { agent, can, defineGroup, defineRole, SixbHost } from "../src"
import {
  type AgentRunSessionHost,
  afterAgentRunFinished,
  claimAgentRun,
  NOOP_STREAM_SINK,
  repairAgentInboxes,
} from "../src/agents"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import type { AppendAgentMessageInput, ConversationAgentRunRecord } from "../src/storage/agents"
import { createTestAgentExecution } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A message queued while a turn runs starts when the turn ends, as the person who queued it: a
// message they sent now starts whatever ended the turn, and one queued for later only after the
// turn answered.

const users = defineGroup("agent-users")
const runner = defineRole("agent.runner", { grantedTo: [users], grants: [can.run(agent)] })

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "queued-turn-tests",
    ontology: [],
    models: { language: [testLanguageModel()] },
    groups: [users],
    roles: [runner],
    ...deps,
  })
  return { host, ...deps }
}

/** The session host the worker and the API open a run's session against: the project itself. */
function sessionHost(
  host: SixbHost,
  deps: ReturnType<typeof createTestRuntimeDeps>
): AgentRunSessionHost {
  return {
    projectId: host.id,
    storage: host.storage as AgentRunSessionHost["storage"],
    broker: deps.broker,
    recoverAiModelCall: async () => {},
    events: NOOP_STREAM_SINK,
    domainEvents: { emit: async () => {} },
    security: host.definitions.security,
    sdk: host,
    definitions: host.definitions,
  }
}

async function userScope(host: SixbHost, id: string) {
  await host.storage.auth!.users.create({ projectId: host.id, id, email: `${id}@example.com` })
  // The role that may run the Agent is granted to this group: a run started without a request
  // resolves the user's grants from their memberships, not from the request's.
  await host.storage.auth!.groupMemberships.upsert({
    projectId: host.id,
    userId: id,
    groupId: users.id,
    source: "manual",
  })
  const sessionId = `session-${id}`
  await host.storage.auth!.sessions.create({
    projectId: host.id,
    id: sessionId,
    userId: id,
    strategyId: "test",
    tokenHash: sessionId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  })
  return bindRequestExecution(host, {
    request: new Request("http://localhost/test"),
    authorization: {
      type: "principal",
      credential: { type: "session", id: sessionId },
      context: {
        principal: { type: "user", id },
        sessionId,
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    },
  })
}

type Requester = Awaited<ReturnType<typeof userScope>>

interface TurnOutcome {
  readonly status: "succeeded" | "cancelled"
  readonly answer?: AppendAgentMessageInput["parts"]
}

/** A turn the requester asks for in the thread, `during` it, and the run as it ended. */
async function turn(
  host: SixbHost,
  deps: ReturnType<typeof createTestRuntimeDeps>,
  sixb: Requester,
  threadId: string,
  outcome: TurnOutcome,
  during: () => Promise<unknown> = async () => {}
) {
  const { run } = await sixb.agent.runs.request({ threadId, text: "Read the book." })
  const session = await claimAgentRun(sessionHost(host, deps), {
    run: run as ConversationAgentRunRecord,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  if (!session) throw new Error("Expected the turn to be claimed.")
  await during()

  const answer: AppendAgentMessageInput[] = []
  if (outcome.answer !== undefined) {
    answer.push({
      id: "msg_answer",
      projectId: host.id,
      threadId,
      runId: run.id,
      role: "assistant",
      parts: outcome.answer,
    })
  }
  const finished = await session.finish(
    {
      status: outcome.status,
      ...(outcome.status === "succeeded" ? { finishReason: "stop" as const } : {}),
    },
    answer
  )
  await session.close()
  return finished as ConversationAgentRunRecord
}

/** A thread with a turn that ran, the messages sent `during` it, and the run as it ended. */
async function finishedTurn(
  host: SixbHost,
  deps: ReturnType<typeof createTestRuntimeDeps>,
  sixb: Requester,
  outcome: TurnOutcome,
  during: (threadId: string) => Promise<unknown> = async () => {}
) {
  const thread = await sixb.agent.threads.create({ title: "Queued messages" })
  const run = await turn(host, deps, sixb, thread.id, outcome, () => during(thread.id))
  return { thread, run }
}

/** The thread's inbox, as the chat reads it: the messages that wait. */
async function inbox(host: SixbHost, threadId: string) {
  const items = await host.storage.agents!.inbox.list({ projectId: host.id, threadId })
  return items.map((item) => item.messageId)
}

/** The turns waiting to run, each with its trigger message. */
async function startedTurns(host: SixbHost, threadId: string) {
  const { runs } = await host.storage.agents!.runs.list({
    projectId: host.id,
    threadId,
    statuses: ["queued"],
  })
  return runs.map((run) => run.triggerMessageId)
}

/** A message the sender queues while a turn runs, or sends now. */
function queueMessage(
  sixb: Requester,
  threadId: string,
  input: { readonly id: string; readonly immediate?: boolean; readonly text?: string }
) {
  return sixb.agent.runs.send({
    threadId,
    text: input.text ?? "Then run the tests.",
    delivery: input.immediate ? "send_now" : "queue",
    messageId: `msg_${input.id}`,
    timeZone: "America/New_York",
    locale: "en-US",
  })
}

describe("what a finished turn starts", () => {
  test("reads the next message its requester queued for the thread", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { thread, run } = await finishedTurn(host, deps, sixb, { status: "succeeded" }, (id) =>
      queueMessage(sixb, id, { id: "inb_1" })
    )

    await afterAgentRunFinished(sessionHost(host, deps), run)

    const started = await host.storage.agents!.runs.list({
      projectId: host.id,
      threadId: thread.id,
      statuses: ["queued"],
    })
    expect(started.runs).toHaveLength(1)
    const next = started.runs[0]!
    expect(next.kind).toBe("conversation")
    // The queued message is the turn's own trigger, and the thread's next message.
    expect(next.triggerMessageId).toBe("msg_inb_1")
    expect(next.spec?.model).toEqual(run.spec?.model)
    expect(next.spec?.timeZone).toBe("America/New_York")

    const trigger = await host.storage.agents!.messages.getById({
      projectId: host.id,
      id: "msg_inb_1",
    })
    expect(trigger?.parts).toEqual([{ type: "text", text: "Then run the tests." }])
    expect(trigger?.authorPrincipal).toEqual({ type: "user", id: "owner" })
    expect(await inbox(host, thread.id)).toEqual([])
    // Dispatched, so a worker picks it up.
    expect(
      await deps.queues.agents.claim({ projectId: host.id, workerId: "w", limit: 1 })
    ).toHaveLength(1)
  })

  test("starts nothing after a turn that was stopped", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { thread, run } = await finishedTurn(host, deps, sixb, { status: "cancelled" }, (id) =>
      queueMessage(sixb, id, { id: "inb_1" })
    )

    await afterAgentRunFinished(sessionHost(host, deps), run)

    expect(await startedTurns(host, thread.id)).toEqual([])
    expect(await inbox(host, thread.id)).toEqual(["msg_inb_1"])
  })

  test("starts a message sent now even after a stop", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { thread, run } = await finishedTurn(host, deps, sixb, { status: "cancelled" }, (id) =>
      queueMessage(sixb, id, { id: "inb_now", immediate: true })
    )

    await afterAgentRunFinished(sessionHost(host, deps), run)

    expect(await startedTurns(host, thread.id)).toEqual(["msg_inb_now"])
    expect(await inbox(host, thread.id)).toEqual([])
  })

  test("waits when the turn asked its requester a question", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const asked: TurnOutcome = {
      status: "succeeded",
      answer: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "ask",
          input: { questions: [] },
          state: "output-available",
          output: { status: "asked", note: "The user sees your questions." },
        },
      ],
    }
    const { thread, run } = await finishedTurn(host, deps, sixb, asked, (id) =>
      queueMessage(sixb, id, { id: "inb_1" })
    )

    await afterAgentRunFinished(sessionHost(host, deps), run)

    expect(await startedTurns(host, thread.id)).toEqual([])
    expect(await inbox(host, thread.id)).toEqual(["msg_inb_1"])
  })

  test("releases a steer the turn never wrote, whatever ended it", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { thread } = await finishedTurn(host, deps, sixb, { status: "cancelled" })
    await host.storage.agents!.inbox.enqueue({
      id: "inb_steer",
      projectId: host.id,
      threadId: thread.id,
      messageId: "msg_inb_steer",
      authorPrincipal: { type: "user", id: "owner" },
      mode: "steer",
      parts: [{ type: "text", text: "Check src/v2." }],
    })
    // A run that claimed it and ended without writing it: a repair pass, or a crash.
    const lostExecution = await createTestAgentExecution(host.storage, {
      projectId: host.id,
      runId: "run_lost",
    })
    await host.storage.agents!.runs.create({
      id: "run_lost",
      projectId: host.id,
      executionId: lostExecution,
      threadId: thread.id,
      triggerMessageId: "msg_inb_steer",
      spec: { model: { provider: "test", modelId: "test-model" } },
    })
    await host.storage.agents!.runs.start({
      projectId: host.id,
      id: "run_lost",
      execution: { token: "tok_lost", queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    await host.storage.agents!.inbox.takeSteers({
      projectId: host.id,
      threadId: thread.id,
      runId: "run_lost",
      executionToken: "tok_lost",
      authorPrincipal: { type: "user", id: "owner" },
      stepIndex: 1,
    })

    const lost = await host.storage.agents!.runs.getById({ projectId: host.id, id: "run_lost" })
    await afterAgentRunFinished(sessionHost(host, deps), lost!)

    const pending = await host.storage.agents!.inbox.list({
      projectId: host.id,
      threadId: thread.id,
    })
    expect(pending.map((item) => ({ id: item.id, claimed: item.claimedBy !== undefined }))).toEqual(
      [{ id: "inb_steer", claimed: false }]
    )
  })
})

describe("what a finished turn starts in a shared thread", () => {
  /** Theo's thread, shared with Mina, who has never written in it. */
  async function sharedThread(host: SixbHost) {
    const owner = await userScope(host, "owner")
    const guest = await userScope(host, "guest")
    const thread = await owner.agent.threads.create({ title: "Shared" })
    await owner.agent.threads.participants.add(thread.id, [{ type: "user", id: "guest" }])
    return { owner, guest, threadId: thread.id }
  }

  /** Whom the thread's waiting turns run as. */
  async function startedAs(host: SixbHost, threadId: string) {
    const { runs } = await host.storage.agents!.runs.list({
      projectId: host.id,
      threadId,
      statuses: ["queued"],
    })
    return Promise.all(
      runs.map(
        async (run) =>
          (await host.storage.executions.getById({ projectId: host.id, id: run.executionId }))
            ?.requestedBy
      )
    )
  }

  // Guard proof: return after the requester's own messages in startNextQueuedMessage, or drop
  // `executionId` from the enqueue in sendAgentMessage; the guest's first message waits for good.
  test("starts a participant's first message as their own turn", async () => {
    const { host, ...deps } = setup()
    const { owner, guest, threadId } = await sharedThread(host)
    const run = await turn(host, deps, owner, threadId, { status: "succeeded" }, () =>
      queueMessage(guest, threadId, { id: "inb_guest", text: "And Halden." })
    )

    await afterAgentRunFinished(sessionHost(host, deps), run)

    expect(await startedTurns(host, threadId)).toEqual(["msg_inb_guest"])
    expect(await startedAs(host, threadId)).toEqual([{ type: "user", id: "guest" }])
  })

  test("starts the requester's own message first, however late it came", async () => {
    const { host, ...deps } = setup()
    const { owner, guest, threadId } = await sharedThread(host)
    const run = await turn(host, deps, owner, threadId, { status: "succeeded" }, async () => {
      await queueMessage(guest, threadId, { id: "inb_guest" })
      await queueMessage(owner, threadId, { id: "inb_owner" })
    })

    await afterAgentRunFinished(sessionHost(host, deps), run)

    expect(await startedTurns(host, threadId)).toEqual(["msg_inb_owner"])
    expect(await inbox(host, threadId)).toEqual(["msg_inb_guest"])
  })

  test("leaves it waiting once its sender can no longer run turns in the thread", async () => {
    const { host, ...deps } = setup()
    const { owner, guest, threadId } = await sharedThread(host)
    const run = await turn(host, deps, owner, threadId, { status: "succeeded" }, () =>
      queueMessage(guest, threadId, { id: "inb_guest" })
    )
    await owner.agent.threads.participants.remove(threadId, { type: "user", id: "guest" })

    await afterAgentRunFinished(sessionHost(host, deps), run)

    expect(await startedTurns(host, threadId)).toEqual([])
    expect(await inbox(host, threadId)).toEqual(["msg_inb_guest"])
  })

  // Guard proof: rethrow every error in boundSender; the ended session stops the whole start, and
  // the next sender's message waits too.
  test("passes over a message whose session ended, and starts the next sender's", async () => {
    const { host, ...deps } = setup()
    const { owner, guest, threadId } = await sharedThread(host)
    const ana = await userScope(host, "ana")
    await owner.agent.threads.participants.add(threadId, [{ type: "user", id: "ana" }])
    const run = await turn(host, deps, owner, threadId, { status: "succeeded" }, async () => {
      await queueMessage(guest, threadId, { id: "inb_guest" })
      await queueMessage(ana, threadId, { id: "inb_ana" })
    })
    await host.storage.auth!.sessions.revoke({
      projectId: host.id,
      id: "session-guest",
      revokedAt: new Date(),
    })

    await afterAgentRunFinished(sessionHost(host, deps), run)

    expect(await startedAs(host, threadId)).toEqual([{ type: "user", id: "ana" }])
    expect(await inbox(host, threadId)).toEqual(["msg_inb_guest"])
  })

  test("the repair pass starts it the same way", async () => {
    const { host, ...deps } = setup()
    const { owner, guest, threadId } = await sharedThread(host)
    // The owner's turn ended without starting it: its process stopped first.
    await turn(host, deps, owner, threadId, { status: "succeeded" }, () =>
      queueMessage(guest, threadId, { id: "inb_guest" })
    )

    await repairAgentInboxes(sessionHost(host, deps), { now: new Date(Date.now() + 60_000) })

    expect(await startedTurns(host, threadId)).toEqual(["msg_inb_guest"])
    expect(await startedAs(host, threadId)).toEqual([{ type: "user", id: "guest" }])
  })
})

describe("the inbox repair pass", () => {
  /** Past the grace a turn's own end has to start what waits. */
  const later = () => new Date(Date.now() + 60_000)

  // Guard proof: return before startNextQueuedMessage in repairThreadInbox; the message queued
  // behind a turn whose end never ran waits for good.
  test("starts what a turn's end never did, by the rules the end applies", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    // Its process stopped before the turn's end read the inbox.
    const { thread } = await finishedTurn(host, deps, sixb, { status: "succeeded" }, (id) =>
      queueMessage(sixb, id, { id: "inb_1" })
    )

    await repairAgentInboxes(sessionHost(host, deps), { now: new Date() })
    expect(await inbox(host, thread.id)).toHaveLength(1)

    await repairAgentInboxes(sessionHost(host, deps), { now: later() })
    expect(await startedTurns(host, thread.id)).toEqual(["msg_inb_1"])
    expect(await inbox(host, thread.id)).toEqual([])
  })

  test("after a stop, starts only the message sent now, and leaves the queued one waiting", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { thread } = await finishedTurn(host, deps, sixb, { status: "cancelled" }, async (id) => {
      await queueMessage(sixb, id, { id: "inb_later" })
      await queueMessage(sixb, id, { id: "inb_now", immediate: true })
    })

    await repairAgentInboxes(sessionHost(host, deps), { now: later() })
    // A second pass finds a turn holding the thread, and starts nothing more.
    await repairAgentInboxes(sessionHost(host, deps), { now: later() })

    expect(await startedTurns(host, thread.id)).toEqual(["msg_inb_now"])
    expect(await inbox(host, thread.id)).toEqual(["msg_inb_later"])
  })
})
