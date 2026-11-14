import { describe, expect, test } from "bun:test"
import { agent, can, defineGroup, defineRole, SixbHost } from "../src"
import {
  afterAgentRunFinished,
  type AgentRunSessionHost,
  claimAgentRun,
  NOOP_STREAM_SINK,
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

/** A thread with a turn that ran, and the run as it ended. */
async function finishedTurn(
  host: SixbHost,
  deps: ReturnType<typeof createTestRuntimeDeps>,
  sixb: Awaited<ReturnType<typeof userScope>>,
  outcome: {
    readonly status: "succeeded" | "cancelled"
    readonly answer?: AppendAgentMessageInput["parts"]
  }
) {
  const thread = await sixb.agent.threads.create({ title: "Queued messages" })
  const { run } = await sixb.agent.runs.request({ threadId: thread.id, text: "Read the book." })
  const session = await claimAgentRun(sessionHost(host, deps), {
    run: run as ConversationAgentRunRecord,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  if (!session) throw new Error("Expected the turn to be claimed.")
  const answer: AppendAgentMessageInput[] = []
  if (outcome.answer !== undefined) {
    answer.push({
      id: "msg_answer",
      projectId: host.id,
      threadId: thread.id,
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
  return { thread, run: finished as ConversationAgentRunRecord }
}

/** The thread's inbox, as the chat reads it. */
function inbox(host: SixbHost, threadId: string) {
  return host.storage.agents!.inbox.list({ projectId: host.id, threadId })
}

async function queueMessage(
  host: SixbHost,
  threadId: string,
  input: { readonly id: string; readonly immediate?: boolean }
) {
  await host.storage.agents!.inbox.enqueue({
    id: input.id,
    projectId: host.id,
    threadId,
    messageId: `msg_${input.id}`,
    authorPrincipal: { type: "user", id: "owner" },
    mode: "queue",
    parts: [{ type: "text", text: "Then run the tests." }],
    timeZone: "America/New_York",
    locale: "en-US",
    ...(input.immediate ? { immediate: true } : {}),
  })
}

describe("what a finished turn starts", () => {
  test("reads the next message its requester queued for the thread", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { thread, run } = await finishedTurn(host, deps, sixb, { status: "succeeded" })
    await queueMessage(host, thread.id, { id: "inb_1" })

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
    const { thread, run } = await finishedTurn(host, deps, sixb, { status: "cancelled" })
    await queueMessage(host, thread.id, { id: "inb_1" })

    await afterAgentRunFinished(sessionHost(host, deps), run)

    const runs = await host.storage.agents!.runs.list({
      projectId: host.id,
      threadId: thread.id,
      statuses: ["queued"],
    })
    expect(runs.runs).toEqual([])
    const pending = await inbox(host, thread.id)
    expect(pending.map((item) => item.id)).toEqual(["inb_1"])
  })

  test("starts a message sent now even after a stop", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { thread, run } = await finishedTurn(host, deps, sixb, { status: "cancelled" })
    await queueMessage(host, thread.id, { id: "inb_now", immediate: true })

    await afterAgentRunFinished(sessionHost(host, deps), run)

    const runs = await host.storage.agents!.runs.list({
      projectId: host.id,
      threadId: thread.id,
      statuses: ["queued"],
    })
    expect(runs.runs.map((each) => each.triggerMessageId)).toEqual(["msg_inb_now"])
    expect(await inbox(host, thread.id)).toEqual([])
  })

  test("waits when the turn asked its requester a question", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { thread, run } = await finishedTurn(host, deps, sixb, {
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
    })
    await queueMessage(host, thread.id, { id: "inb_1" })

    await afterAgentRunFinished(sessionHost(host, deps), run)

    const runs = await host.storage.agents!.runs.list({
      projectId: host.id,
      threadId: thread.id,
      statuses: ["queued"],
    })
    expect(runs.runs).toEqual([])
    const pending = await inbox(host, thread.id)
    expect(pending.map((item) => item.id)).toEqual(["inb_1"])
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

    const pending = await inbox(host, thread.id)
    expect(
      pending.map((item) => ({ id: item.id, claimed: item.claimedBy !== undefined }))
    ).toEqual([{ id: "inb_steer", claimed: false }])
  })
})
