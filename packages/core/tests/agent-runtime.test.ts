import { describe, expect, test } from "bun:test"
import { agent, can, defineGroup, defineRole, emptyGrantIndex, SixbHost } from "../src"
import { bindRequestExecution } from "../src/execution/request"
import { createTestAgentExecution, createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const users = defineGroup("agent-users")
const runner = defineRole("agent.runner", { grantedTo: [users], grants: [can.run(agent)] })

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "agent-runtime-tests",
    ontology: [],
    models: { language: [testLanguageModel()] },
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
    audience: "atlas",
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
      requesterGroupIds: [],
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
