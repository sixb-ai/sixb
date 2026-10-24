import { describe, expect, test } from "bun:test"
import { agent, can, defineGroup, defineRole, SixbHost } from "../src"
import { AGENT_CONTINUATION_INSTRUCTION, toModelMessages } from "../src/agents/adapters"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import { defineLanguageModel, type ModelCatalogInput } from "../src/models"
import { createTestAgentExecution, createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const users = defineGroup("agent-users")
const runner = defineRole("agent.runner", { grantedTo: [users], grants: [can.run(agent)] })

function setup(language: ModelCatalogInput["language"] = [testLanguageModel()]) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "agent-runtime-tests",
    ontology: [],
    models: { language },
    groups: [users],
    roles: [runner],
    ...deps,
  })
  return { host, ...deps }
}

async function userScope(host: ReturnType<typeof setup>["host"], id: string, allowed = true) {
  await host.storage.auth!.users.create({ projectId: host.id, id, email: `${id}@example.com` })
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
        grants: { ...emptyGrantIndex(), "run:agent": allowed },
      },
    },
  })
}

describe("single project Agent", () => {
  test("captures model selection and user authority without creating an Agent service account", async () => {
    const { host, storage } = setup()
    const sixb = await userScope(host, "owner")
    const thread = await sixb.agent.threads.create({ title: "Hello" })
    expect(thread).not.toHaveProperty("agentId")
    const { run } = await sixb.agent.runs.request({
      threadId: thread.id,
      text: "Hi",
      reasoning: "low",
    })
    expect(run).not.toHaveProperty("agentId")
    expect(await sixb.agent.threads.getById(thread.id)).not.toHaveProperty("agentId")
    expect((await sixb.agent.threads.list()).threads[0]).not.toHaveProperty("agentId")
    expect(await sixb.agent.runs.getById(run.id)).not.toHaveProperty("agentId")
    expect((await sixb.agent.runs.listForThread(thread.id))?.runs[0]).not.toHaveProperty("agentId")
    expect(
      await storage.agents.runs.getById({ projectId: host.id, id: run.id })
    ).not.toHaveProperty("agentId")
    expect(run.spec).toEqual({
      model: { provider: "test", modelId: "test-model" },
      reasoning: "low",
      approvalMode: "manual",
    })
    expect(
      await storage.executions.getById({ projectId: host.id, id: run.executionId })
    ).toMatchObject({
      authorizationRef: {
        type: "principal",
        principal: { type: "user", id: "owner" },
        credential: { type: "session", id: "session-owner" },
      },
      requestedBy: { type: "user", id: "owner" },
    })
    expect((await storage.auth.serviceAccounts.list({ projectId: host.id })).total).toBe(0)
  })

  test("freezes the model's default reasoning when a turn omits it", async () => {
    // Proven by removal: drop `?? model.model.defaultReasoning` from resolveConversationRunSpec.
    const { host } = setup([
      { ...testLanguageModel(), defaultReasoning: "low" },
      testLanguageModel("plain-model"),
    ])
    const sixb = await userScope(host, "owner")
    const first = await sixb.agent.runs.request({ text: "Hi" })
    expect(first.run.spec).toEqual({
      model: { provider: "test", modelId: "test-model" },
      reasoning: "low",
      approvalMode: "manual",
    })
    const plain = await sixb.agent.runs.request({
      text: "Hi",
      model: { provider: "test", modelId: "plain-model" },
    })
    expect(plain.run.spec).toEqual({
      model: { provider: "test", modelId: "plain-model" },
      approvalMode: "manual",
    })
  })

  test("rejects a reasoning the selected model cannot use before creating history", async () => {
    // Proven by removal: skip assertModelSupportsReasoning; the run is admitted with "max".
    const binding = testLanguageModel()
    const { host, storage } = setup([
      {
        ...binding,
        // Admission checks the resolved capabilities, which the configured ones may not declare.
        async resolve() {
          return {
            ...binding,
            definition: defineLanguageModel({
              ...binding.definition,
              capabilities: { reasoning: { efforts: ["low", "high"] } },
            }),
          }
        },
      },
    ])
    const sixb = await userScope(host, "owner")
    await expect(sixb.agent.runs.request({ text: "Hi", reasoning: "max" })).rejects.toMatchObject({
      code: "invalid_model_selection",
      message:
        "[Sixb] Language model 'test/test-model' cannot use this reasoning: reasoning effort 'max' is not supported.",
    })
    expect((await storage.agents.threads.list({ projectId: host.id })).total).toBe(0)
    const { run } = await sixb.agent.runs.request({ text: "Hi", reasoning: "high" })
    expect(run.spec?.reasoning).toBe("high")
  })

  test("freezes the requester's canonical time zone and locale on the run", async () => {
    // Proven by removal: drop timeZone/locale from resolveConversationRunSpec.
    const { host, storage } = setup()
    const sixb = await userScope(host, "owner")
    const { run } = await sixb.agent.runs.request({
      text: "Hi",
      timeZone: "europe/paris",
      locale: "fr-ca",
    })
    expect(run.spec).toMatchObject({ timeZone: "Europe/Paris", locale: "fr-CA" })

    for (const [settings, message] of [
      [{ timeZone: "Etc/Unknown" }, `'timeZone' must be an IANA time zone; received "Etc/Unknown"`],
      [{ locale: "fr_FR" }, `'locale' must be a BCP 47 language tag; received "fr_FR"`],
    ] as const) {
      await expect(sixb.agent.runs.request({ text: "Hi", ...settings })).rejects.toMatchObject({
        code: "invalid_locale",
        message: expect.stringContaining(message),
      })
    }
    expect((await storage.agents.threads.list({ projectId: host.id })).total).toBe(1)
  })

  test("continues a cut-short answer with a framework-written instruction", async () => {
    // Proven by removal: send `continue` as user text; the model then reads the user's words.
    const { host, storage } = setup([testLanguageModel(), testLanguageModel("deep-model")])
    const sixb = await userScope(host, "owner")
    const { run } = await sixb.agent.runs.request({
      text: "Write the report",
      model: { provider: "test", modelId: "deep-model" },
      reasoning: "high",
    })
    await storage.agents.runs.finishQueued({ projectId: host.id, id: run.id, status: "cancelled" })
    const continued = await sixb.agent.runs.request({ threadId: run.threadId, continue: true })
    const trigger = await storage.agents.messages.getById({
      projectId: host.id,
      id: continued.run.triggerMessageId,
    })
    expect(trigger).toMatchObject({ role: "user", parts: [{ type: "continuation" }] })
    // It keeps the cut-short turn's model and reasoning. Proven by removal: drop continuedSelection.
    expect(continued.run.spec).toMatchObject({
      model: { provider: "test", modelId: "deep-model" },
      reasoning: "high",
    })
    expect(toModelMessages([trigger!])).toEqual([
      { role: "user", content: [{ type: "text", text: AGENT_CONTINUATION_INSTRUCTION }] },
    ])

    for (const input of [
      { continue: true },
      { threadId: run.threadId, continue: true, text: "Continue" },
      { threadId: run.threadId },
    ]) {
      await expect(sixb.agent.runs.request(input)).rejects.toMatchObject({
        code: expect.stringMatching(/^(thread_not_found|invalid_message)$/),
      })
    }
  })

  test("rejects removed selectors and unknown models before creating history", async () => {
    const { host, storage } = setup()
    const sixb = createTestSixb(host)
    // Regression proof: removing assertNoAgentSelector admits these JavaScript-shaped requests.
    await expect(
      sixb.agent.threads.create({
        // @ts-expect-error a conversation no longer selects an Agent
        agentId: "legacy",
      })
    ).rejects.toMatchObject({ code: "agent_selector_removed" })
    await expect(
      sixb.agent.runs.listForThread("thread", {
        // @ts-expect-error run history no longer selects an Agent
        agentId: "legacy",
      })
    ).rejects.toMatchObject({ code: "agent_selector_removed" })
    await expect(
      sixb.agent.runs.request({
        // @ts-expect-error old SDK requests must not be silently retargeted
        agentId: "legacy",
        text: "Hi",
      })
    ).rejects.toMatchObject({ code: "agent_selector_removed" })
    await expect(
      sixb.agent.runs.request({ text: "Hi", model: { provider: "test", modelId: "missing" } })
    ).rejects.toMatchObject({ code: "model_not_found" })
    expect((await storage.agents.threads.list({ projectId: host.id })).total).toBe(0)
  })

  test("keeps existing conversations owner-scoped and writable", async () => {
    const { host, storage } = setup()
    const owner = await userScope(host, "owner")
    const other = await userScope(host, "other")
    const denied = await userScope(host, "denied", false)
    const thread = await storage.agents.threads.create({
      projectId: host.id,
      id: "legacy-thread",
      ownerPrincipal: { type: "user", id: "owner" },
    })
    const message = await storage.agents.messages.append({
      projectId: host.id,
      id: "legacy-message",
      threadId: thread.id,
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "Original question" }],
    })
    const executionId = await createTestAgentExecution(storage, {
      projectId: host.id,
      runId: "legacy-run",
      authority: "inherited",
    })
    await storage.agents.runs.create({
      id: "legacy-run",
      projectId: host.id,
      threadId: thread.id,
      executionId,
      triggerMessageId: message.id,
      spec: { model: { provider: "test", modelId: "test-model" } },
    })
    const run = await storage.agents.runs.finishQueued({
      projectId: host.id,
      id: "legacy-run",
      status: "failed",
    })
    expect(await owner.agent.threads.getById(thread.id)).toMatchObject({ id: thread.id })
    expect(await owner.agent.threads.getById(thread.id)).not.toHaveProperty("agentId")
    expect((await owner.agent.threads.list()).total).toBe(1)
    expect(await owner.agent.runs.getById(run.id)).toMatchObject({ executionId })
    expect(await owner.agent.runs.getById(run.id)).not.toHaveProperty("agentId")
    expect(await other.agent.threads.getById(thread.id)).toBeNull()
    expect((await other.agent.threads.list()).total).toBe(0)
    await expect(
      other.agent.runs.request({ threadId: thread.id, text: "Hello" })
    ).rejects.toMatchObject({ code: "thread_not_found" })
    expect(await denied.agent.runs.getById(run.id)).toBeNull()
    const continued = await owner.agent.runs.request({ threadId: thread.id, text: "Continue" })
    expect(continued.run.threadId).toBe(thread.id)
    expect(
      (await storage.agents.messages.list({ projectId: host.id, threadId: thread.id })).messages
    ).toHaveLength(2)
    expect(await storage.agents.runs.getById({ projectId: host.id, id: run.id })).toEqual(run)
    expect((await storage.agents.runs.list({ projectId: host.id })).total).toBe(2)
  })
})

describe("forking a conversation", () => {
  async function conversationWithRunningTurn(host: ReturnType<typeof setup>["host"]) {
    const { storage } = host
    const agents = storage.agents!
    const thread = await agents.threads.create({
      projectId: host.id,
      id: "deals-thread",
      ownerPrincipal: { type: "user", id: "owner" },
      title: "Slipped deals",
    })
    await agents.messages.append({
      projectId: host.id,
      id: "question",
      threadId: thread.id,
      runId: null,
      role: "user",
      authorPrincipal: { type: "user", id: "owner" },
      parts: [{ type: "text", text: "Which deals slipped?" }],
    })

    const executionId = await createTestAgentExecution(storage, {
      projectId: host.id,
      runId: "answered-run",
      authority: "inherited",
    })
    await agents.runs.create({
      id: "answered-run",
      projectId: host.id,
      threadId: thread.id,
      executionId,
      triggerMessageId: "question",
      spec: { model: { provider: "test", modelId: "test-model" } },
    })
    await agents.runs.finishQueued({ projectId: host.id, id: "answered-run", status: "failed" })
    await agents.messages.append({
      projectId: host.id,
      id: "answer",
      threadId: thread.id,
      runId: "answered-run",
      role: "assistant",
      parts: [{ type: "text", text: "Three deals slipped." }],
    })

    return thread
  }

  test("copies the finished history into a thread the caller owns", async () => {
    // Removal proof: copy every message while a turn is running in planAgentThreadFork; the
    // queued question lands in the fork, which then holds three messages.
    const { host, storage } = setup()
    const owner = await userScope(host, "owner")
    const thread = await conversationWithRunningTurn(host)
    const running = await owner.agent.runs.request({ threadId: thread.id, text: "Draft emails" })

    const fork = await owner.agent.threads.fork(thread.id)

    expect(fork).toMatchObject({
      ownerPrincipal: { type: "user", id: "owner" },
      title: "Slipped deals",
      activeRunId: null,
      messageCount: 2,
    })
    expect(fork.id).not.toBe(thread.id)

    const copied = await storage.agents.messages.list({ projectId: host.id, threadId: fork.id })
    expect(copied.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "Which deals slipped?" }],
      [{ type: "text", text: "Three deals slipped." }],
    ])
    expect(copied.messages.map((message) => message.runId)).toEqual([null, "answered-run"])

    // The fork is idle at once; the source keeps its running turn.
    const next = await owner.agent.runs.request({ threadId: fork.id, text: "Draft emails" })
    expect(next.run.threadId).toBe(fork.id)
    expect(await owner.agent.threads.getById(thread.id)).toMatchObject({
      activeRunId: running.run.id,
      messageCount: 3,
    })
    expect((await owner.agent.threads.list()).total).toBe(2)
  })

  test("forks only a thread the caller can read", async () => {
    // Removal proof: read the source from storage instead of getVisibleThreadRecord; another
    // user forks the owner's conversation.
    const { host, storage } = setup()
    const thread = await conversationWithRunningTurn(host)
    const other = await userScope(host, "other")
    const denied = await userScope(host, "denied", false)

    for (const scope of [other, denied]) {
      await expect(scope.agent.threads.fork(thread.id)).rejects.toMatchObject({
        code: "thread_not_found",
      })
    }
    await expect(other.agent.threads.fork("missing")).rejects.toMatchObject({
      code: "thread_not_found",
    })
    expect((await storage.agents.threads.list({ projectId: host.id })).total).toBe(1)
  })
})
