import { describe, expect, test } from "bun:test"
import type { AgentWorkspaceConfig, OntologySource, ParamsConfig, SandboxFactory } from "../src"
import {
  AgentDefinitionError,
  defineObjectType,
  emptyGrantIndex,
  objectRef,
  optional,
  param,
  prop,
  ref,
  SixbHost,
} from "../src"
import { createTestAgentExecution, createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const forbidden = async (): Promise<never> => {
  throw new Error("Must not create a sandbox")
}
const sandboxes: SandboxFactory = {
  create: forbidden,
  persistence: { create: forbidden, resume: forbidden },
}

function setup(agentWorkspace?: AgentWorkspaceConfig, ontology: readonly OntologySource[] = []) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "workspaces",
    ontology,
    ...deps,
    sandboxes,
    models: { language: [testLanguageModel()] },
    agentWorkspace,
  })
  return { host, sixb: createTestSixb(host), ...deps }
}

const recipe = (): AgentWorkspaceConfig => ({
  params: { clientId: param("string"), branch: optional(param("string")) },
  resolve: forbidden,
})

describe("Agent workspace binding", () => {
  test("captures host-side auth without persisting or invoking it at thread creation", async () => {
    let calls = 0
    const auth = {
      authorize: async () => {
        calls++
        return forbidden()
      },
    }
    const { host, sixb } = setup({ params: {}, resolve: forbidden, auth })
    const thread = await sixb.agent.threads.create({ workspace: { params: {} } })
    expect(calls).toBe(0)
    expect(thread.workspace).toEqual({ params: {} })
    auth.authorize = async () => {
      throw new Error("replacement")
    }
    await expect(
      host.definitions.agentWorkspace!.auth!.authorize({
        source: { type: "git", url: "https://github.com/acme/repo.git" },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("Must not create a sandbox")
    expect(calls).toBe(1)
  })
  test("requires persistent provider support at configuration time", () => {
    expect(() => {
      new SixbHost({
        ontology: [],
        ...createTestRuntimeDeps(),
        agentWorkspace: recipe(),
      })
    }).toThrow("requires a sandbox provider with persistence support")
  })

  test("rejects malformed schemas before serving requests", () => {
    for (const params of [
      { clientId: "string" },
      { clientId: { schema: "typo", required: true } },
      { clientId: { schema: "string", required: "yes" } },
      { clientId: { schema: "string", semanticType: {} } },
    ]) {
      expect(() => setup({ ...recipe(), params: params as unknown as ParamsConfig })).toThrow(
        AgentDefinitionError
      )
    }
  })

  test("shares Action object-reference params without treating a reference as authorization", async () => {
    const Client = defineObjectType({
      id: "Client",
      name: "Client",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const config: AgentWorkspaceConfig = {
      params: { client: param(ref(Client)) },
      resolve: forbidden,
    }
    const { sixb } = setup(config, [Client])
    // No object is loaded at binding time. Current access must be checked by the run resolver.
    const client = objectRef(Client, "acme")
    const thread = await sixb.agent.threads.create({ workspace: { params: { client } } })
    expect(thread.workspace).toEqual({ params: { client } })
    await expect(
      sixb.agent.threads.create({
        workspace: { params: { client: { objectTypeId: "Other", primaryId: "acme" } } },
      })
    ).rejects.toMatchObject({ code: "invalid_workspace_params" })
  })

  test("creates optional immutable bindings without resolving or starting a sandbox", async () => {
    const { sixb } = setup(recipe())
    expect(await sixb.agent.threads.create({})).not.toHaveProperty("workspace")
    const input = { params: { clientId: "acme" } }
    const thread = await sixb.agent.threads.create({ id: "bound", workspace: input })
    input.params.clientId = "changed"
    expect(thread.workspace).toEqual({ params: { clientId: "acme" } })
    expect((await sixb.agent.threads.getById(thread.id))?.workspace).toEqual(thread.workspace)
    await expect(
      sixb.agent.threads.create({
        id: thread.id,
        workspace: { params: { clientId: "other" } },
      })
    ).rejects.toMatchObject({ code: "duplicate_id" })
    expect((await sixb.agent.threads.getById(thread.id))?.workspace).toEqual(thread.workspace)
  })

  test("rejects absent configuration, unknown fields and invalid values without creating history", async () => {
    const disabled = setup()
    await expect(
      disabled.sixb.agent.threads.create({ workspace: { params: {} } })
    ).rejects.toMatchObject({ code: "workspace_not_configured" })
    const { sixb } = setup(recipe())
    for (const params of [
      {},
      { clientId: null },
      { clientId: 42 },
      { clientId: "acme", extra: true },
    ]) {
      await expect(sixb.agent.threads.create({ workspace: { params } })).rejects.toMatchObject({
        code: "invalid_workspace_params",
      })
    }
    await expect(
      sixb.agent.threads.create({
        // @ts-expect-error only application params belong in the binding
        workspace: { params: { clientId: "acme" }, env: { TOKEN: "secret" } },
      })
    ).rejects.toMatchObject({ code: "invalid_workspace_params" })
    expect((await sixb.agent.threads.list()).total).toBe(0)
  })

  test("captures schema and resolver, normalizes dates and invokes with the supplied scoped SDK", async () => {
    let calls = 0
    const config: AgentWorkspaceConfig = {
      params: {
        requestedAt: param("timestamp"),
        note: optional(param("string", { nullable: true })),
      },
      resolve: ({ params, sixb }) => {
        calls++
        expect(params.requestedAt).toBeInstanceOf(Date)
        expect(sixb.execution).toBeDefined()
        return {
          source: { type: "git", url: "https://github.com/acme/app.git" },
          env: { APP_SETTING: "transient" },
        }
      },
    }
    const { host, sixb } = setup(config)
    config.params.requestedAt = param("string")
    const date = new Date("2026-09-13T10:00:00.000Z")
    const thread = await sixb.agent.threads.create({
      workspace: { params: { requestedAt: date, note: null } },
    })
    expect(calls).toBe(0)
    expect(thread.workspace).toEqual({ params: { requestedAt: date.toISOString(), note: null } })
    const definition = host.definitions.agentWorkspace!
    expect(Object.isFrozen(definition.params.requestedAt)).toBe(true)
    await definition.resolve({ params: thread.workspace!.params, sixb })
    expect(calls).toBe(1)
    expect((await sixb.agent.threads.getById(thread.id))?.workspace).toEqual(thread.workspace)
  })

  test("admits fresh workspaces but denies runs and retries after uncertain work", async () => {
    // Regression proof: remove assertWorkspaceExecutionAvailable in requestAgentRun/retryAgentRun.
    const { host, sixb, storage } = setup(recipe())
    const thread = await sixb.agent.threads.create({ workspace: { params: { clientId: "acme" } } })
    const admitted = await sixb.agent.runs.request({ threadId: thread.id, text: "Do some work" })
    await storage.agents.runs.start({
      projectId: host.id,
      id: admitted.run.id,
      execution: { token: "owner", queueLeaseExpiresAt: new Date("2099-01-01") },
    })
    await storage.agents.threads.transitionWorkspace({
      projectId: host.id,
      id: thread.id,
      action: "acquire",
      runId: admitted.run.id,
      executionToken: "owner",
      generation: "test-generation",
      sourceFingerprint: "a".repeat(64),
    })
    await storage.agents.runs.finish({
      projectId: host.id,
      id: admitted.run.id,
      executionToken: "owner",
      status: "failed",
    })
    await expect(
      sixb.agent.runs.request({ threadId: thread.id, text: "Try again" })
    ).rejects.toMatchObject({ code: "workspace_execution_unavailable" })
    expect(
      (await storage.agents.messages.list({ projectId: host.id, threadId: thread.id })).messages
    ).toHaveLength(1)
    expect((await sixb.agent.runs.listForThread(thread.id))?.runs).toHaveLength(1)
    const executionId = await createTestAgentExecution(storage, {
      projectId: host.id,
      runId: "failed",
      authority: "inherited",
    })
    await storage.agents.runs.create({
      id: "failed",
      projectId: host.id,
      executionId,
      threadId: thread.id,
      triggerMessageId: "msg",
      spec: { model: { provider: "test", modelId: "model" } },
      requesterGroupIds: [],
    })
    await storage.agents.runs.finishQueued({ projectId: host.id, id: "failed", status: "failed" })
    await expect(sixb.agent.runs.retry("failed")).rejects.toMatchObject({
      code: "workspace_execution_unavailable",
    })
    expect((await sixb.agent.runs.listForThread(thread.id))?.runs).toHaveLength(2)
    const visible = await sixb.agent.threads.getById(thread.id)
    expect(visible?.workspaceState).not.toHaveProperty("owner")
    const recreated = await sixb.agent.threads.recreateWorkspace(thread.id, {
      expectedGeneration: "test-generation",
    })
    expect(recreated.workspaceState?.status).toBe("new")
  })

  test("keeps bindings private to the thread owner", async () => {
    const { host } = setup(recipe())
    const as = (id: string) =>
      createTestSixb(host, {
        authorization: {
          principal: { type: "user", id },
          groupIds: [],
          roleIds: [],
          grants: { ...emptyGrantIndex(), "run:agent": true },
        },
      })
    const thread = await as("alice").agent.threads.create({
      workspace: { params: { clientId: "acme" } },
    })
    expect(await as("bob").agent.threads.getById(thread.id)).toBeNull()
    expect((await as("bob").agent.threads.list()).total).toBe(0)
    await expect(
      as("bob").agent.runs.request({ threadId: thread.id, text: "Hello" })
    ).rejects.toMatchObject({ code: "thread_not_found" })
  })
})
