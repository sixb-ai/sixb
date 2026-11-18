import { describe, expect, test } from "bun:test"
import { AgentRequestError, agent, can, defineGroup, defineRole, SixbHost } from "../src"
import { createAgentRunExecutionToken } from "../src/agents/ids"
import { readAgentTurnHistory } from "../src/agents/run-turn"
import { projectAgentThreadModelContext } from "../src/agents/thread-context-projection"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import type {
  DecisionModel,
  DecisionModelRequest,
  DecisionModelResult,
  LanguageModelTier,
  ModelCatalogInput,
} from "../src/models"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const users = defineGroup("agent-users")
const runner = defineRole("agent.runner", { grantedTo: [users], grants: [can.run(agent)] })

const flash = testLanguageModel("flash")
const sonnet = testLanguageModel("sonnet")
const opus = testLanguageModel("opus")
const tiers = { light: flash, standard: sonnet, heavy: opus }

function decisionModel(
  evaluate: (request: DecisionModelRequest) => Promise<DecisionModelResult>
): DecisionModel {
  return {
    providerId: "test",
    modelId: "router",
    definition: {
      kind: "decision",
      providerId: "test",
      modelId: "router",
      capabilities: { questions: ["choice"] },
    },
    evaluate,
  }
}

function tierAnswer(probabilities: Record<LanguageModelTier, number>): DecisionModelResult {
  const [choice] = Object.entries(probabilities).sort(([, left], [, right]) => right - left)[0]!
  return { output: { tier: { choice, probabilities } } }
}

function setup(models: ModelCatalogInput = { language: [testLanguageModel()] }) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "agent-edit-tests",
    ontology: [],
    models,
    groups: [users],
    roles: [runner],
    ...deps,
  })
  return { host, ...deps }
}

async function userScope(host: ReturnType<typeof setup>["host"], id: string) {
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
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    },
  })
}

/** Edit a message of an idle thread: the edit starts its turn at once. */
async function editNow(
  sixb: Awaited<ReturnType<typeof userScope>>,
  input: Parameters<Awaited<ReturnType<typeof userScope>>["agent"]["runs"]["editMessage"]>[0]
) {
  const result = await sixb.agent.runs.editMessage(input)
  if (result.kind !== "turn") throw new Error("Expected the edit to start its turn now.")
  return result
}

async function completeTurn(
  storage: ReturnType<typeof setup>["storage"],
  projectId: string,
  runId: string,
  threadId: string,
  replyText: string,
  replyId = `reply-${runId}`,
  /** The folder a computer thread's runner starts the turn in. */
  onComputer?: { readonly id: string; readonly folder: string }
) {
  const token = createAgentRunExecutionToken()
  await storage.agents.runs.start({
    id: runId,
    projectId,
    execution: { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    ...(onComputer ? { onComputer } : {}),
  })
  await storage.agents.messages.append({
    id: replyId,
    projectId,
    threadId,
    runId,
    role: "assistant",
    parts: [{ type: "text", text: replyText }],
  })
  await storage.agents.runs.finish({
    id: runId,
    projectId,
    executionToken: token,
    status: "succeeded",
  })
  return token
}

describe("editing an Agent thread message", () => {
  test("truncates the edited turn and later turns, keeps earlier checkpoints, and drops later checkpoints", async () => {
    // Guard proof: omit checkpoints.deleteAfterSeq or messages.deleteFromSeq in editAgentMessage;
    // projectAgentThreadModelContext either throws on a sequence gap or leaks Turn 3's summary.
    const { host, storage } = setup()
    const sixb = await userScope(host, "alice")
    const thread = await sixb.agent.threads.create({ title: "Q4 plan" })

    const t1 = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Turn 1 prompt",
      messageId: "u1",
    })
    await completeTurn(storage, host.id, t1.run.id, thread.id, "Turn 1 answer", "a1")

    const t2 = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Turn 2 prompt",
      messageId: "u2",
    })
    const tok2 = createAgentRunExecutionToken()
    await storage.agents.runs.start({
      id: t2.run.id,
      projectId: host.id,
      execution: { token: tok2, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    await storage.agents.checkpoints.create({
      id: "cp_before_t2",
      projectId: host.id,
      threadId: thread.id,
      createdByRunId: t2.run.id,
      expectedPreviousCheckpointId: null,
      expectedHeadSeq: 3,
      executionToken: tok2,
      reason: "threshold",
      summary: "Summary of Turn 1.",
      summaryFormatVersion: 1,
      summarizedThroughSeq: 2,
      observedHeadSeq: 3,
      estimatedInputTokensBefore: 1000,
      estimatedInputTokensAfter: 300,
      summaryModelId: "test-model",
    })
    await storage.agents.messages.append({
      id: "a2",
      projectId: host.id,
      threadId: thread.id,
      runId: t2.run.id,
      role: "assistant",
      parts: [{ type: "text", text: "Turn 2 answer" }],
    })
    await storage.agents.runs.finish({
      id: t2.run.id,
      projectId: host.id,
      executionToken: tok2,
      status: "succeeded",
    })

    const t3 = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Turn 3 prompt",
      messageId: "u3",
    })
    const tok3 = createAgentRunExecutionToken()
    await storage.agents.runs.start({
      id: t3.run.id,
      projectId: host.id,
      execution: { token: tok3, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    await storage.agents.checkpoints.create({
      id: "cp_before_t3",
      projectId: host.id,
      threadId: thread.id,
      createdByRunId: t3.run.id,
      expectedPreviousCheckpointId: "cp_before_t2",
      expectedHeadSeq: 5,
      executionToken: tok3,
      reason: "threshold",
      summary: "Summary of Turn 1 and Turn 2.",
      summaryFormatVersion: 1,
      summarizedThroughSeq: 4,
      observedHeadSeq: 5,
      estimatedInputTokensBefore: 1400,
      estimatedInputTokensAfter: 350,
      summaryModelId: "test-model",
    })
    await storage.agents.messages.append({
      id: "a3",
      projectId: host.id,
      threadId: thread.id,
      runId: t3.run.id,
      role: "assistant",
      parts: [{ type: "text", text: "Turn 3 answer" }],
    })
    await storage.agents.runs.finish({
      id: t3.run.id,
      projectId: host.id,
      executionToken: tok3,
      status: "succeeded",
    })

    // Editing Turn 3 keeps cp_before_t2 (observedHeadSeq 3 <= 4) and drops cp_before_t3 (observedHeadSeq 5).
    const editedT3 = await editNow(sixb, {
      threadId: thread.id,
      messageId: "u3",
      text: "Turn 3 revised",
      nextMessageId: "u3_v2",
    })
    expect(editedT3.run.triggerMessageId).toBe("u3_v2")

    const historyAtT3 = await readAgentTurnHistory(
      { projectId: host.id, storage: { agents: storage.agents, aiUsage: storage.aiUsage } },
      thread.id
    )
    expect(historyAtT3.checkpoint?.id).toBe("cp_before_t2")
    expect(historyAtT3.messages.map((m) => ({ id: m.id, seq: m.seq }))).toEqual([
      { id: "u2", seq: 3 },
      { id: "a2", seq: 4 },
      { id: "u3_v2", seq: 5 },
    ])
    expect(() =>
      projectAgentThreadModelContext({
        checkpoint: historyAtT3.checkpoint,
        messages: historyAtT3.messages,
      })
    ).not.toThrow()

    await completeTurn(storage, host.id, editedT3.run.id, thread.id, "Turn 3 revised answer")

    // Editing Turn 1 rewinds to seq 1, dropping cp_before_t2 too while preserving all 4 past runs.
    const editedT1 = await editNow(sixb, {
      threadId: thread.id,
      messageId: "u1",
      text: "Fresh start",
      nextMessageId: "u1_v2",
    })
    const historyAtT1 = await readAgentTurnHistory(
      { projectId: host.id, storage: { agents: storage.agents, aiUsage: storage.aiUsage } },
      thread.id
    )
    expect(historyAtT1.checkpoint).toBeNull()
    expect(historyAtT1.messages.map((m) => ({ id: m.id, seq: m.seq }))).toEqual([
      { id: "u1_v2", seq: 1 },
    ])
    expect((await sixb.agent.runs.listForThread(thread.id))?.total).toBe(5)
    expect(editedT1.run.status).toBe("queued")
  })

  test("re-reports an earlier turn's approval outcome onto the edited message and removes rewound turns' approvals", async () => {
    // Guard proof: skip clearing reportedInMessageId in approvals.rewind; Turn 1's denied approval
    // disappears from u2_v2.
    const { host, storage } = setup()
    const sixb = await userScope(host, "alice")
    const thread = await sixb.agent.threads.create({ title: "Approvals" })

    const t1 = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Pay invoice",
      messageId: "u1",
      approvalMode: "manual",
    })
    const tok1 = createAgentRunExecutionToken()
    await storage.agents.runs.start({
      id: t1.run.id,
      projectId: host.id,
      execution: { token: tok1, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    await storage.agents.approvals.request({
      id: "apr_turn1",
      projectId: host.id,
      runId: t1.run.id,
      callerRunId: t1.run.id,
      executionToken: tok1,
      requestedBy: { type: "user", id: "alice" },
      mode: "manual",
      call: { kind: "workflow", workflowId: "wf_pay", input: {}, workflowRunId: "wfr_1" },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    })
    await storage.agents.runs.finish({
      id: t1.run.id,
      projectId: host.id,
      executionToken: tok1,
      status: "succeeded",
      finishReason: "awaiting_approval",
    })

    // Sending Turn 2 supersedes apr_turn1 and reports its outcome inside u2.
    const t2 = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Skip payment and list vendors",
      messageId: "u2",
      approvalMode: "manual",
    })
    const tok2 = createAgentRunExecutionToken()
    await storage.agents.runs.start({
      id: t2.run.id,
      projectId: host.id,
      execution: { token: tok2, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    await storage.agents.approvals.request({
      id: "apr_turn2",
      projectId: host.id,
      runId: t2.run.id,
      callerRunId: t2.run.id,
      executionToken: tok2,
      requestedBy: { type: "user", id: "alice" },
      mode: "manual",
      call: { kind: "workflow", workflowId: "wf_vendors", input: {}, workflowRunId: "wfr_2" },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    })
    await storage.agents.runs.finish({
      id: t2.run.id,
      projectId: host.id,
      executionToken: tok2,
      status: "succeeded",
      finishReason: "awaiting_approval",
    })

    // Now edit u2: apr_turn2 is deleted, while apr_turn1 is re-reported onto u2_v2.
    await editNow(sixb, {
      threadId: thread.id,
      messageId: "u2",
      text: "Skip payment and check contracts instead",
      nextMessageId: "u2_v2",
    })

    const replacement = await storage.agents.messages.getById({ projectId: host.id, id: "u2_v2" })
    expect(replacement?.parts).toEqual([
      expect.objectContaining({
        type: "approval-outcome",
        approvalId: "apr_turn1",
        status: "superseded",
      }),
      { type: "text", text: "Skip payment and check contracts instead" },
    ])
    expect(
      await storage.agents.approvals.getById({ projectId: host.id, id: "apr_turn2" })
    ).toBeNull()
  })

  test("routes an edited first turn fresh and an edited later turn against the retained prefix's model", async () => {
    // Guard proof: route the edit against latestConversationRun instead of
    // latestRetainedConversationRun in editAgentMessage; editing u1 stays stuck on opus even for a
    // light greeting.
    let nextTier: Record<LanguageModelTier, number> = { light: 0, standard: 0.1, heavy: 0.9 }
    const { host, storage } = setup({
      language: tiers,
      decision: [decisionModel(async () => tierAnswer(nextTier))],
    })
    const sixb = await userScope(host, "alice")
    const thread = await sixb.agent.threads.create({ title: "Routing" })

    const t1 = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Deep architectural trade-off analysis",
      messageId: "u1",
    })
    expect(t1.run.spec?.model.modelId).toBe("opus")
    await completeTurn(storage, host.id, t1.run.id, thread.id, "Analysis done.")

    // Turn 2 asks an easy question while Turn 1's opus cache is warm -> stays on opus.
    nextTier = { light: 0.9, standard: 0.1, heavy: 0 }
    const t2 = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Count rows",
      messageId: "u2",
    })
    expect(t2.run.spec?.model.modelId).toBe("opus")
    await completeTurn(storage, host.id, t2.run.id, thread.id, "42 rows.")

    // Editing u2 keeps Turn 1's warm opus cache.
    const editedU2 = await editNow(sixb, {
      threadId: thread.id,
      messageId: "u2",
      text: "Count active rows",
      nextMessageId: "u2_v2",
    })
    expect(editedU2.run.spec?.model.modelId).toBe("opus")
    await completeTurn(storage, host.id, editedU2.run.id, thread.id, "30 active rows.")

    // Editing u1 (seq 1) has no retained prefix before it, so a light prompt routes to flash.
    const editedU1 = await editNow(sixb, {
      threadId: thread.id,
      messageId: "u1",
      text: "Hi!",
    })
    expect(editedU1.run.spec?.model.modelId).toBe("flash")
  })

  test("runs an edited turn in the thread's folder and keeps the model whose cache is warm there", async () => {
    // Guard proof: write only `runsOn` into the edited run's spec, or route it without its place
    // (request.ts, editAgentMessage); the turn loses its folder, reads as moved, and steps down to
    // flash, leaving opus's cached prefix behind.
    let nextTier: Record<LanguageModelTier, number> = { light: 0, standard: 0.1, heavy: 0.9 }
    const { host, storage } = setup({
      language: tiers,
      decision: [decisionModel(async () => tierAnswer(nextTier))],
    })
    const sixb = await userScope(host, "alice")
    const thread = await sixb.agent.threads.create({ title: "Release notes" })
    const folder = { id: "cmp_1", folder: "/work/sixb" }
    await sixb.agent.threads.moveToComputer(thread.id, { ...folder, name: "Laptop" })

    const t1 = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Plan the release",
      messageId: "u1",
    })
    await completeTurn(storage, host.id, t1.run.id, thread.id, "Plan ready.", "a1", folder)

    const t2 = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "List the changes",
      messageId: "u2",
    })
    await completeTurn(storage, host.id, t2.run.id, thread.id, "12 changes.", "a2", folder)

    nextTier = { light: 0.9, standard: 0.1, heavy: 0 }
    const edited = await editNow(sixb, {
      threadId: thread.id,
      messageId: "u2",
      text: "List the breaking changes",
    })

    expect(edited.run.spec).toMatchObject({
      model: { provider: "test", modelId: "opus" },
      runsOn: "computer",
      computer: folder,
    })
  })

  test("takes back an artifact two rewound turns wrote, as it was before the first", async () => {
    // Guard proof: pass `laterTurnRunIds: []` in rewindAgentThread, undoing each turn alone;
    // undoing turn 2 moves the plan's revision, so turn 1 counts as touched by someone else and
    // its plan stays, though the turn that made it is gone from the thread.
    const { host, storage } = setup()
    const sixb = await userScope(host, "alice")
    const thread = await sixb.agent.threads.create({ title: "Q4 plan" })
    const alice = { type: "user", id: "alice" } as const

    const document = async (title: string, runId: string) => ({
      title,
      entry: "plan.md",
      files: [
        {
          path: "plan.md",
          file: await host.blobStorage.put({
            body: new TextEncoder().encode(`# ${title}`),
            fileName: "plan.md",
            mediaType: "text/markdown",
          }),
        },
      ],
      outline: { kind: "document" as const, headings: [] },
      references: [],
      author: alice,
      origin: { threadId: thread.id, runId },
      updatedAt: new Date(),
    })

    const turnWriting = async (
      text: string,
      messageId: string,
      write: (runId: string) => Promise<unknown>
    ) => {
      const { run } = await sixb.agent.runs.request({ threadId: thread.id, text, messageId })
      const token = createAgentRunExecutionToken()
      await storage.agents.runs.start({
        id: run.id,
        projectId: host.id,
        execution: { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
      })
      await write(run.id)
      await storage.agents.runs.finish({
        id: run.id,
        projectId: host.id,
        executionToken: token,
        status: "succeeded",
      })
    }

    await turnWriting("Write the Q4 plan", "u1", async (runId) =>
      storage.artifacts.create({
        projectId: host.id,
        id: "art_plan",
        kind: "document",
        owner: alice,
        version: await document("Q4 plan", runId),
        turnRunId: runId,
      })
    )
    await turnWriting("Add the hiring budget", "u2", async (runId) =>
      storage.artifacts.publish({
        projectId: host.id,
        artifactId: "art_plan",
        kind: "document",
        version: await document("Q4 plan with hiring", runId),
        turnRunId: runId,
      })
    )

    await editNow(sixb, { threadId: thread.id, messageId: "u1", text: "Write the Q1 plan" })

    expect(await storage.artifacts.get({ projectId: host.id, id: "art_plan" })).toBeNull()
  })

  test("refuses to edit a message a turn read while it was answering, and leaves the thread as it was", async () => {
    // Guard proof: drop assertRewindsWholeTurns in editAgentMessage; the steer's edit rewinds the
    // whole turn that read it, while the turn's first answer stays in the thread.
    const { host, storage } = setup()
    const sixb = await userScope(host, "alice")
    const thread = await sixb.agent.threads.create({ title: "Q4 deck" })

    const turn = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Make the Q4 deck",
      messageId: "u1",
    })
    const token = createAgentRunExecutionToken()
    await storage.agents.runs.start({
      id: turn.run.id,
      projectId: host.id,
      execution: { token, queueLeaseExpiresAt: new Date(Date.now() + 60_000) },
    })
    // The turn answers, reads Alice's steer, and answers it: one turn around her message.
    for (const message of [
      { id: "a1", runId: turn.run.id, role: "assistant", text: "I made the Q4 deck." },
      { id: "s1", runId: null, role: "user", text: "Add hiring" },
      { id: "a2", runId: turn.run.id, role: "assistant", text: "Hiring added." },
    ] as const) {
      await storage.agents.messages.append({
        id: message.id,
        projectId: host.id,
        threadId: thread.id,
        runId: message.runId,
        role: message.role,
        parts: [{ type: "text", text: message.text }],
        ...(message.role === "user" ? { authorPrincipal: { type: "user", id: "alice" } } : {}),
      })
    }
    await storage.agents.runs.finish({
      id: turn.run.id,
      projectId: host.id,
      executionToken: token,
      status: "succeeded",
    })

    const error = await sixb.agent.runs
      .editMessage({ threadId: thread.id, messageId: "s1", text: "Add the budget" })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(AgentRequestError)
    expect(error.code).toBe("message_not_editable")
    const { messages } = await storage.agents.messages.list({
      projectId: host.id,
      threadId: thread.id,
      order: "asc",
    })
    expect(messages.map((message) => message.id)).toEqual(["u1", "a1", "s1", "a2"])
  })

  test("prevents a shared-thread participant from rewinding past another person's message", async () => {
    const { host, storage } = setup()
    const alice = await userScope(host, "alice")
    const bob = await userScope(host, "bob")
    const thread = await alice.agent.threads.create({ title: "Shared" })
    await alice.agent.threads.participants.add(thread.id, [{ type: "user", id: "bob" }])

    const t1 = await bob.agent.runs.request({
      threadId: thread.id,
      text: "Bob first",
      messageId: "b1",
    })
    await completeTurn(storage, host.id, t1.run.id, thread.id, "Reply 1")

    const t2 = await alice.agent.runs.request({
      threadId: thread.id,
      text: "Alice follow-up",
      messageId: "a1",
    })
    await completeTurn(storage, host.id, t2.run.id, thread.id, "Reply 2")

    const error = await bob.agent.runs
      .editMessage({ threadId: thread.id, messageId: "b1", text: "Bob tries to erase Alice" })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AgentRequestError)
    expect(error).toMatchObject({ code: "not_thread_owner" })
  })
})
