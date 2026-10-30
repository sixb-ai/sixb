import { describe, expect, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage, type SecurityDefinitionCatalog } from "../src"
import { claimAgentRun, NOOP_STREAM_SINK } from "../src/agents"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestAgentExecution } from "../src/testing"

const PROJECT_ID = "agent-run-turn-tests"
const LEASE = "2099-01-01T00:00:00.000Z"
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

async function setup() {
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
    const session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })
    if (!session) throw new Error("Expected the run to be claimed.")
    return session
  }
  return { storage, thread, say, turn, open }
}

describe("a turn's context", () => {
  // Guard proof: return every participant from readReaders; Cleo and Dan, who cannot read the
  // thread, are then named to the model as taking part.
  test("names the participants who can read the thread now, and the people it names", async () => {
    const { storage, thread, say, turn, open } = await setup()
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
    const { storage, thread, say, turn, open } = await setup()
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
