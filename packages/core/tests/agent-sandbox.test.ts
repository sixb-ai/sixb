import { describe, expect, test } from "bun:test"
import type {
  OntologySource,
  ParamsConfig,
  SandboxConfig,
  SandboxEnvironment,
  SandboxFactory,
} from "../src"
import {
  defineObjectType,
  objectRef,
  optional,
  param,
  prop,
  ref,
  SandboxError,
  SixbHost,
} from "../src"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestAgentExecution, createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const forbidden = async (): Promise<never> => {
  throw new Error("Must not create a sandbox")
}
const sandboxes: SandboxFactory = {
  create: forbidden,
  resume: forbidden,
}

function setup(configuration?: SandboxConfig, ontology: readonly OntologySource[] = []) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "workspaces",
    ontology,
    ...deps,
    sandboxes: { ...sandboxes, configuration },
    models: { language: [testLanguageModel()] },
  })
  return { host, sixb: createTestSixb(host), ...deps }
}

const recipe = (): SandboxConfig => ({
  params: { clientId: param("string"), branch: optional(param("string")) },
  resolve: forbidden,
})

describe("Agent sandbox binding", () => {
  test("captures source authentication without invoking it or exposing it in the recipe", async () => {
    let calls = 0
    const auth = {
      authorize: async () => {
        calls++
        throw new Error("not invoked by configuration")
      },
    }
    const { host, sixb } = setup({
      auth,
      source: { type: "git", url: "https://github.com/acme/app" },
    })
    const captured = host.sandboxDefinition!.auth!
    auth.authorize = async () => {
      throw new Error("mutated")
    }
    expect(await host.sandboxDefinition!.resolve({ params: {}, sixb })).not.toHaveProperty("auth")
    expect(calls).toBe(0)
    await expect(
      captured.authorize({
        source: { type: "git", url: "https://github.com/acme/app" },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("not invoked by configuration")
    expect(calls).toBe(1)
  })

  test("captures a static environment and keeps it out of discovery and thread history", async () => {
    // Regression proof: bypass captureEnvironment's snapshot; caller mutation changes the recipe.
    const source = { type: "git" as const, url: "https://github.com/acme/app.git" }
    const commands = ["bun install"]
    const { host, sixb } = setup({ source, setup: commands })
    source.url = "https://github.com/other/app.git"
    commands.push("unexpected")
    const thread = await sixb.agent.threads.create({ sandbox: {} })
    expect(thread.sandboxParams).toEqual({})
    expect(host.definitions).not.toHaveProperty("agentWorkspace")
    const resolved = await host.sandboxDefinition!.resolve({ params: {}, sixb })
    expect(resolved).toEqual({
      source: { type: "git", url: "https://github.com/acme/app.git" },
      setup: ["bun install"],
    })
    await expect(
      sixb.agent.threads.create({ sandbox: { undeclared: true } })
    ).rejects.toMatchObject({ code: "invalid_sandbox_params" })
  })

  test("supports a source-free environment", async () => {
    const { host, sixb } = setup({})
    expect((await sixb.agent.threads.create({ sandbox: {} })).sandboxParams).toEqual({})
    expect(await host.sandboxDefinition!.resolve({ params: {}, sixb })).toEqual({})
  })

  test("rejects ambiguous configurations and malformed static environments early", () => {
    // Regression proof: bypass captureEnvironment's validation; invalid sources are admitted.
    const invalid: unknown[] = [
      { params: { id: param("string") } },
      { resolve: forbidden, setup: [] },
      { resolve: forbidden, source: { type: "git", url: "https://github.com/acme/app" } },
      { source: { type: "tarball", url: "https://example.com/app.tgz" } },
      { source: { type: "git", url: "https://token@github.com/acme/app" } },
      { source: { type: "git", url: "https://github.com/acme/app", password: "secret" } },
      { source: { type: "git", url: "https://github.com/acme/app", revision: "--help" } },
      { source: { type: "git", url: "https://github.com/acme/app", access: "admin" } },
      { setup: [null] },
      { setup: "bun install" },
      { env: { TOKEN: 123 } },
      { network: { mode: "invalid" } },
      {
        network: {
          mode: "restricted",
          allow: [{ name: "registry", origin: "https://example.com/path" }],
        },
      },
    ]
    for (const config of invalid) {
      expect(() => {
        setup(config as SandboxConfig)
      }).toThrow(SandboxError)
    }
  })

  test("resolves with current authority on every invocation and validates returned data", async () => {
    let calls = 0
    const { host, sixb } = setup({
      env: { BASE: "base" },
      resolve: ({ sixb: scoped }) => {
        expect(scoped).toBe(sixb)
        calls++
        return { env: { RUN: String(calls) } }
      },
    })
    expect(calls).toBe(0)
    expect(await host.sandboxDefinition!.resolve({ params: {}, sixb })).toEqual({
      env: { BASE: "base", RUN: "1" },
    })
    expect(await host.sandboxDefinition!.resolve({ params: {}, sixb })).toEqual({
      env: { BASE: "base", RUN: "2" },
    })
    const invalid = setup({ resolve: () => ({ source: { type: "git", url: "file:///etc" } }) })
    await expect(invalid.host.sandboxDefinition!.resolve({ params: {}, sixb })).rejects.toThrow(
      SandboxError
    )
  })

  test.each([
    null,
    { unknown: true },
    { source: { type: "git", url: "not-a-url" } },
    { source: { type: "git", url: "https://example.com/repo?token=secret" } },
    { source: { type: "git", url: "https://example.com/repo#secret" } },
    { source: { type: "git", url: "https://example.com/repo", revision: "\nmain" } },
    { setup: [" "] },
    { setup: ["echo\0secret"] },
    { env: { "INVALID=KEY": "secret" } },
    { env: { KEY: "secret\0" } },
    { network: null },
    { network: { mode: "none", allow: [] } },
    { network: { mode: "restricted", allow: null } },
    { network: { mode: "restricted", allow: [null] } },
    { network: { mode: "restricted", allow: [{ name: " ", origin: "https://example.com" }] } },
    { network: { mode: "restricted", allow: [{ name: "api", origin: "invalid" }] } },
    { network: { mode: "restricted", allow: [{ name: "api", origin: "ftp://example.com" }] } },
  ])("rejects malformed environments both at registration and resolution: %j", async (value) => {
    // Regression proof: bypass captureEnvironment's validators; these invalid recipes are admitted.
    expect(() => setup(value as SandboxConfig)).toThrow(SandboxError)
    const { host, sixb } = setup({ resolve: () => value as SandboxEnvironment })
    await expect(host.sandboxDefinition!.resolve({ params: {}, sixb })).rejects.toThrow(
      SandboxError
    )
  })

  test.each([
    { mode: "none" as const },
    { mode: "all" as const },
    {
      mode: "restricted" as const,
      allow: [{ name: "api", origin: "https://example.com" }],
    },
  ])("captures a valid network policy: %j", async (network) => {
    const { host, sixb } = setup({ network })
    const resolved = await host.sandboxDefinition!.resolve({ params: {}, sixb })
    expect(resolved.network).toEqual(network)
    expect(resolved.network).not.toBe(network)
  })

  test.each([
    undefined,
    { create: forbidden },
    { create: forbidden, persistence: { create: forbidden, resume: forbidden } },
    { create: forbidden, resume: true },
  ])("requires a callable resume capability before creating a bound thread: %j", async (provider) => {
    // Regression proof: remove the admission guard in createAgentRuntime (or check only truthiness).
    // Missing, legacy and malformed capabilities must not admit a persistent thread.
    const host = new SixbHost({
      ontology: [],
      ...createTestRuntimeDeps(),
      models: { language: [testLanguageModel()] },
      sandboxes: { ...provider, configuration: recipe() } as unknown as SandboxFactory,
    })
    await expect(
      createTestSixb(host).agent.threads.create({ sandbox: { clientId: "acme" } })
    ).rejects.toThrow("require a provider with persistence support")
  })

  test("rejects malformed schemas before serving requests", () => {
    for (const params of [
      { clientId: "string" },
      { clientId: { schema: "typo", required: true } },
      { clientId: { schema: "string", required: "yes" } },
      { clientId: { schema: "string", semanticType: {} } },
    ]) {
      expect(() => setup({ ...recipe(), params: params as unknown as ParamsConfig })).toThrow(
        SandboxError
      )
    }
  })

  test("shares Action object-reference params without treating a reference as authorization", async () => {
    const Client = defineObjectType({
      id: "Client",
      name: "Client",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const config: SandboxConfig = {
      params: { client: param(ref(Client)) },
      resolve: forbidden,
    }
    const { sixb } = setup(config, [Client])
    // No object is loaded at binding time. Current access must be checked by the run resolver.
    const client = objectRef(Client, "acme")
    const thread = await sixb.agent.threads.create({ sandbox: { client } })
    expect(thread.sandboxParams).toEqual({ client })
    await expect(
      sixb.agent.threads.create({
        sandbox: { client: { objectTypeId: "Other", primaryId: "acme" } },
      })
    ).rejects.toMatchObject({ code: "invalid_sandbox_params" })
  })

  test("creates optional immutable bindings without resolving or starting a sandbox", async () => {
    const { sixb } = setup(recipe())
    expect(await sixb.agent.threads.create({})).not.toHaveProperty("sandbox")
    const input = { clientId: "acme" }
    const thread = await sixb.agent.threads.create({ id: "bound", sandbox: input })
    input.clientId = "changed"
    expect(thread.sandboxParams).toEqual({ clientId: "acme" })
    expect((await sixb.agent.threads.getById(thread.id))?.sandboxParams).toEqual(
      thread.sandboxParams
    )
    await expect(
      sixb.agent.threads.create({
        id: thread.id,
        sandbox: { clientId: "other" },
      })
    ).rejects.toMatchObject({ code: "duplicate_id" })
    expect((await sixb.agent.threads.getById(thread.id))?.sandboxParams).toEqual(
      thread.sandboxParams
    )
  })

  test("rejects absent configuration, unknown fields and invalid values without creating history", async () => {
    const disabled = setup()
    await expect(disabled.sixb.agent.threads.create({ sandbox: {} })).rejects.toMatchObject({
      code: "sandbox_not_configured",
    })
    const { sixb } = setup(recipe())
    for (const params of [
      {},
      { clientId: null },
      { clientId: 42 },
      { clientId: "acme", extra: true },
    ]) {
      await expect(sixb.agent.threads.create({ sandbox: params })).rejects.toMatchObject({
        code: "invalid_sandbox_params",
      })
    }
    await expect(
      sixb.agent.threads.create({
        sandbox: { params: { clientId: "acme" }, env: { TOKEN: "secret" } },
      })
    ).rejects.toMatchObject({ code: "invalid_sandbox_params" })
    expect((await sixb.agent.threads.list()).total).toBe(0)
  })

  test("captures schema and resolver, normalizes dates and invokes with the supplied scoped SDK", async () => {
    let calls = 0
    const config: SandboxConfig = {
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
    config.params!.requestedAt = param("string")
    const date = new Date("2026-09-13T10:00:00.000Z")
    const thread = await sixb.agent.threads.create({
      sandbox: { requestedAt: date, note: null },
    })
    expect(calls).toBe(0)
    expect(thread.sandboxParams).toEqual({ requestedAt: date.toISOString(), note: null })
    const definition = host.sandboxDefinition!
    expect(Object.isFrozen(definition.params.requestedAt)).toBe(true)
    await definition.resolve({ params: thread.sandboxParams!, sixb })
    expect(calls).toBe(1)
    expect((await sixb.agent.threads.getById(thread.id))?.sandboxParams).toEqual(
      thread.sandboxParams
    )
  })

  test("admits fresh workspaces but denies runs and retries after uncertain work", async () => {
    // Regression proof: remove assertSandboxExecutionAvailable in requestAgentRun/retryAgentRun.
    const { host, sixb, storage } = setup(recipe())
    const thread = await sixb.agent.threads.create({ sandbox: { clientId: "acme" } })
    const admitted = await sixb.agent.runs.request({ threadId: thread.id, text: "Do some work" })
    await storage.agents.runs.start({
      projectId: host.id,
      id: admitted.run.id,
      execution: { token: "owner", queueLeaseExpiresAt: new Date("2099-01-01") },
    })
    await storage.agents.threads.transitionSandbox({
      projectId: host.id,
      id: thread.id,
      action: "acquire",
      runId: admitted.run.id,
      executionToken: "owner",
      name: "test-name",
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
    ).rejects.toMatchObject({ code: "sandbox_execution_unavailable" })
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
    })
    await storage.agents.runs.finishQueued({ projectId: host.id, id: "failed", status: "failed" })
    await expect(sixb.agent.runs.retry("failed")).rejects.toMatchObject({
      code: "sandbox_execution_unavailable",
    })
    expect((await sixb.agent.runs.listForThread(thread.id))?.runs).toHaveLength(2)
    const visible = await sixb.agent.threads.getById(thread.id)
    expect(visible?.sandboxState).not.toHaveProperty("owner")
    const recreated = await sixb.agent.threads.recreateSandbox(thread.id, {
      expectedSandboxName: "test-name",
    })
    expect(recreated.sandboxState?.status).toBe("new")
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
      sandbox: { clientId: "acme" },
    })
    expect(await as("bob").agent.threads.getById(thread.id)).toBeNull()
    expect((await as("bob").agent.threads.list()).total).toBe(0)
    await expect(
      as("bob").agent.runs.request({ threadId: thread.id, text: "Hello" })
    ).rejects.toMatchObject({ code: "thread_not_found" })
  })
})
