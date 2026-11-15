import { describe, expect, test } from "bun:test"
import { agent, can, defineGroup, defineRole, SixbHost } from "../src"
import type { AgentRunSession, AgentRunSessionHost } from "../src/agents"
import { claimAgentRun, NOOP_STREAM_SINK } from "../src/agents"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import type { ConversationAgentRunRecord } from "../src/storage/agents"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A message sent while a turn runs is steered into it, queued for the next turn, or made to go now,
// and only the person who asked for the turn may steer it or hurry its end.

const users = defineGroup("agent-users")
const runner = defineRole("agent.runner", { grantedTo: [users], grants: [can.run(agent)] })

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "inbox-message-tests",
    ontology: [],
    models: { language: [testLanguageModel()] },
    groups: [users],
    roles: [runner],
    ...deps,
  })
  return { host, ...deps }
}

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
        groupIds: [users.id],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    },
  })
}

/** A conversation whose turn runs: its session holds the thread. */
async function runningTurn(
  host: SixbHost,
  deps: ReturnType<typeof createTestRuntimeDeps>,
  sixb: Awaited<ReturnType<typeof userScope>>
): Promise<{ threadId: string; session: AgentRunSession<ConversationAgentRunRecord> }> {
  const thread = await sixb.agent.threads.create({ title: "Inbox" })
  const { run } = await sixb.agent.runs.request({ threadId: thread.id, text: "Read the book." })
  const session = await claimAgentRun(sessionHost(host, deps), {
    run: run as ConversationAgentRunRecord,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  if (!session) throw new Error("Expected the turn to be claimed.")
  return { threadId: thread.id, session }
}

describe("a message sent while a turn runs", () => {
  test("steers it when the person who asked for the turn sends it", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { threadId, session } = await runningTurn(host, deps, sixb)

    const sent = await sixb.agent.runs.send({
      threadId,
      text: "Check src/v2 instead.",
      delivery: "steer",
      timeZone: "America/New_York",
      locale: "en-US",
    })

    expect(sent.kind).toBe("inbox")
    if (sent.kind !== "inbox") throw new Error("Expected an inbox item.")
    expect(sent.item.mode).toBe("steer")
    expect(sent.item.authorPrincipal).toEqual({ type: "user", id: "owner" })
    expect(sent.item.parts).toEqual([{ type: "text", text: "Check src/v2 instead." }])
    expect(sent.item.timeZone).toBe("America/New_York")
    expect(sent.item.immediate).toBeUndefined()
    // The thread stays with the turn that runs: nothing was added to it yet.
    expect(
      await host.storage.agents!.messages.list({ projectId: host.id, threadId })
    ).toMatchObject({
      total: 1,
    })
    await session.close()
  })

  test("queues for the next turn when someone else sends it", async () => {
    const { host, ...deps } = setup()
    const owner = await userScope(host, "owner")
    const { threadId, session } = await runningTurn(host, deps, owner)
    // The owner shares the conversation with a participant, who sends a message of their own.
    const guest = await userScope(host, "guest")
    await owner.agent.threads.participants.add(threadId, [{ type: "user", id: "guest" }])
    const refused = await guest.agent.runs
      .send({ threadId, text: "And the fixtures.", delivery: "steer" })
      .catch((error: unknown) => error)
    expect(String(refused)).toContain("only they can steer it")

    const queued = await guest.agent.runs.send({
      threadId,
      text: "And the fixtures.",
      delivery: "queue",
    })
    expect(queued.kind).toBe("inbox")
    if (queued.kind !== "inbox") throw new Error("Expected an inbox item.")
    expect(queued.item.mode).toBe("queue")
    expect(queued.item.authorPrincipal).toEqual({ type: "user", id: "guest" })
    await session.close()
  })

  test("refuses to start a turn while one runs, as a plain message always did", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { threadId, session } = await runningTurn(host, deps, sixb)

    const refused = await sixb.agent.runs
      .send({ threadId, text: "One more thing." })
      .catch((error: unknown) => error)
    expect(String(refused)).toContain("already has an active run")
    await session.close()
  })

  test("stops the turn when it is sent now, and carries no file into a steer", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { threadId, session } = await runningTurn(host, deps, sixb)

    const refused = await sixb.agent.runs
      .send({
        threadId,
        text: "Look at this.",
        delivery: "steer",
        attachments: [
          {
            blobId: "blob_1",
            digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            sizeBytes: 12,
            fileName: "chart.png",
            mediaType: "image/png",
          },
        ],
      })
      .catch((error: unknown) => error)
    expect(String(refused)).toContain("carries no file")

    const sentNow = await sixb.agent.runs.send({
      threadId,
      text: "Stop, run the tests first.",
      delivery: "send_now",
    })
    expect(sentNow.kind).toBe("inbox")
    if (sentNow.kind !== "inbox") throw new Error("Expected an inbox item.")
    expect(sentNow.item.immediate).toBe(true)
    // The turn it waits behind was asked to stop, which its runner hears.
    if (!session.cancelled.aborted) {
      await new Promise<void>((resolve) =>
        session.cancelled.addEventListener("abort", () => resolve(), { once: true })
      )
    }
    expect(session.cancelled.aborted).toBe(true)
    await session.close()
  })

  test("changes, promotes and withdraws a message before a turn reads it", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { threadId, session } = await runningTurn(host, deps, sixb)

    const queued = await sixb.agent.runs.send({
      threadId,
      text: "Check the fixtures.",
      delivery: "queue",
      reasoning: "high",
    })
    if (queued.kind !== "inbox") throw new Error("Expected an inbox item.")

    const listed = await sixb.agent.inbox.list(threadId)
    expect(listed.map((item) => item.id)).toEqual([queued.item.id])

    const edited = await sixb.agent.inbox.update(threadId, queued.item.id, {
      text: "Check src/v2 instead.",
      delivery: "steer",
    })
    expect(edited.mode).toBe("steer")
    expect(edited.parts).toEqual([{ type: "text", text: "Check src/v2 instead." }])
    expect(edited.spec?.reasoning).toBe("high")

    await sixb.agent.inbox.remove(threadId, queued.item.id)
    expect(await sixb.agent.inbox.list(threadId)).toEqual([])
    await session.close()
  })

  // Guard proof: pass the edit's spec to inbox.update as it came; the item loses its model.
  test("keeps the model it asked for when only its reasoning changes", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { threadId, session } = await runningTurn(host, deps, sixb)
    const model = { provider: "test", modelId: "test-model" }

    const queued = await sixb.agent.runs.send({
      threadId,
      text: "Then sum it.",
      delivery: "queue",
      model,
    })
    if (queued.kind !== "inbox") throw new Error("Expected an inbox item.")
    const edited = await sixb.agent.inbox.update(threadId, queued.item.id, { reasoning: "high" })

    expect(edited.spec).toEqual({ model, reasoning: "high" })
    await session.close()
  })
})

describe("a message whose turn ended first", () => {
  /** Queued messages the thread started as turns: their trigger messages. */
  async function startedTurns(host: SixbHost, threadId: string) {
    const { runs } = await host.storage.agents!.runs.list({
      projectId: host.id,
      threadId,
      statuses: ["queued"],
    })
    return runs.map((run) => run.triggerMessageId)
  }

  // Guard proof: drop startIfThreadIdle from sendAgentMessage; the turn's end read an empty inbox,
  // and the message waits on an idle thread.
  test("starts when the turn ended before the message reached the inbox", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { threadId, session } = await runningTurn(host, deps, sixb)

    // The turn answers and ends just after the send read the thread as running.
    const running = await host.storage.agents!.threads.getById({ projectId: host.id, id: threadId })
    await session.finish({ status: "succeeded", finishReason: "stop" })
    const { threads, inbox } = host.storage.agents!
    const getById = threads.getById.bind(threads)
    const enqueue = inbox.enqueue.bind(inbox)
    let stale = true
    threads.getById = async (input) => (stale && input.id === threadId ? running : getById(input))
    inbox.enqueue = async (input) => {
      stale = false
      return enqueue(input)
    }
    const queued = await sixb.agent.runs.send({ threadId, text: "Then sum it.", delivery: "queue" })
    threads.getById = getById
    inbox.enqueue = enqueue
    if (queued.kind !== "inbox") throw new Error("Expected an inbox item.")

    expect(await startedTurns(host, threadId)).toEqual([queued.item.messageId])
    expect(await sixb.agent.inbox.list(threadId)).toEqual([])
    await session.close()
  })

  // Guard proof: drop startIfThreadIdle from promoteAgentInboxItem; with no turn to stop, Send now
  // marks the message and starts nothing.
  test("starts when it is sent now and no turn holds the thread", async () => {
    const { host, ...deps } = setup()
    const sixb = await userScope(host, "owner")
    const { threadId, session } = await runningTurn(host, deps, sixb)
    const queued = await sixb.agent.runs.send({ threadId, text: "Then sum it.", delivery: "queue" })
    if (queued.kind !== "inbox") throw new Error("Expected an inbox item.")
    // The turn was stopped: a message queued for later waits behind it.
    await session.finish({ status: "cancelled" })
    await session.close()
    expect(await startedTurns(host, threadId)).toEqual([])

    await sixb.agent.inbox.update(threadId, queued.item.id, { immediate: true })

    expect(await startedTurns(host, threadId)).toEqual([queued.item.messageId])
  })
})
