import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import { createSixb, defineAgent, defineObjectType, prop } from "../src"
import { createModelCatalog } from "../src/models"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const tempRoots = new Set<string>()

function testModel(provider: string, modelId: string): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider,
    modelId,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Not implemented by the test model.")
    },
    async doStream() {
      throw new Error("Not implemented by the test model.")
    },
  } as LanguageModelV4
}

const gpt = testModel("gateway", "openai/gpt-5.4")
const sonnet = testModel("gateway", "anthropic/claude-sonnet-4.6")

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sixb-core-models-"))
  tempRoots.add(projectRoot)
  return projectRoot
}

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true })
  }
  tempRoots.clear()
})

describe("createModelCatalog", () => {
  test("exposes the binding identity without creating another model id", () => {
    const catalog = createModelCatalog({ language: [gpt] })

    expect(catalog.language.list().map(({ provider, modelId }) => ({ provider, modelId }))).toEqual(
      [{ provider: "gateway", modelId: "openai/gpt-5.4" }]
    )
  })

  test("preserves the configured order", () => {
    const catalog = createModelCatalog({ language: [gpt, sonnet] })

    expect(catalog.language.list().map((entry) => entry.modelId)).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4.6",
    ])
  })

  test("uses the first language model as the default", () => {
    const catalog = createModelCatalog({ language: [gpt, sonnet] })

    expect(catalog.language.default.model).toBe(gpt)
  })

  test("resolves an entry by reference and returns null for an unknown one", () => {
    const catalog = createModelCatalog({ language: [gpt] })

    expect(
      catalog.language.getByRef({ provider: "gateway", modelId: "openai/gpt-5.4" })?.model
    ).toBe(gpt)
    expect(catalog.language.getByRef({ provider: "gateway", modelId: "openai/gpt-9" })).toBeNull()
  })

  test("rejects two models that derive the same reference", () => {
    // Proven by removal: drop the `byRef.has(ref)` guard in `createModelCatalog` and this fails —
    // the second entry replaces the first in the lookup while `list()` still reports both.
    expect(() =>
      createModelCatalog({ language: [gpt, testModel("gateway", "openai/gpt-5.4")] })
    ).toThrow(/Duplicate language model 'gateway\/openai\/gpt-5\.4'/)
  })

  test("keeps one vendor model configured through two bindings as two entries", () => {
    const catalog = createModelCatalog({
      language: [testModel("openai.chat", "gpt-5.4"), testModel("openai.responses", "gpt-5.4")],
    })

    expect(catalog.language.list().map((entry) => entry.provider)).toEqual([
      "openai.chat",
      "openai.responses",
    ])
  })

  test("does not collide when delimiters appear in provider or modelId", () => {
    // Proven by removal: a lookup keyed by `${provider}/${modelId}` makes these bindings collide.
    const first = testModel("a/b", "c")
    const second = testModel("a", "b/c")
    const catalog = createModelCatalog({ language: [first, second] })

    expect(catalog.language.getByRef({ provider: "a/b", modelId: "c" })?.model).toBe(first)
    expect(catalog.language.getByRef({ provider: "a", modelId: "b/c" })?.model).toBe(second)
  })

  test("rejects an empty language catalog", () => {
    // Proven by removal: drop the `defaultEntry === undefined` guard and this fails, because
    // `default` then reads as undefined instead of the catalog refusing to exist.
    expect(() => createModelCatalog({ language: [] })).toThrow(
      /'models.language' needs at least one model/
    )
  })

  test("rejects a malformed language catalog", () => {
    expect(() =>
      createModelCatalog({ language: null } as unknown as Parameters<typeof createModelCatalog>[0])
    ).toThrow(/'models.language' must be an array/)
  })

  test.each([
    ["specificationVersion", { specificationVersion: "v3" }],
    ["supportedUrls", { supportedUrls: undefined }],
    ["supportedUrls", { supportedUrls: [] }],
    ["doGenerate", { doGenerate: undefined }],
    ["doStream", { doStream: undefined }],
  ])("rejects an invalid %s field", (_field, override) => {
    const invalid = { ...gpt, ...override } as unknown as LanguageModelV4

    expect(() => createModelCatalog({ language: [invalid] })).toThrow(/Invalid language model/)
  })

  test("accepts promised supported URL metadata", () => {
    const model = { ...gpt, supportedUrls: Promise.resolve({}) } as LanguageModelV4

    expect(createModelCatalog({ language: [model] }).language.default.model).toBe(model)
  })

  test("accepts a callable PromiseLike for supported URL metadata", () => {
    const supportedUrls = () => {}
    // biome-ignore lint/suspicious/noThenProperty: the AI SDK contract explicitly permits PromiseLike metadata.
    Object.defineProperty(supportedUrls, "then", { value: () => {} })
    const model = { ...gpt, supportedUrls } as unknown as LanguageModelV4

    expect(createModelCatalog({ language: [model] }).language.default.model).toBe(model)
  })

  test.each([
    ["provider", ""],
    ["provider", " gateway"],
    ["modelId", ""],
    ["modelId", "openai/gpt-5.4 "],
  ] as const)("rejects an invalid %s identity", (field, value) => {
    const invalid = { ...gpt, [field]: value } as LanguageModelV4

    expect(() => createModelCatalog({ language: [invalid] })).toThrow(/Invalid language model/)
  })

  test("does not freeze the provider-owned model", () => {
    const model = testModel("gateway", "openai/gpt-5.4")

    createModelCatalog({ language: [model] })

    expect(Object.isFrozen(model)).toBe(false)
  })
})

describe("createSixb models", () => {
  test("registers the configured catalog", async () => {
    const projectRoot = await createTempProjectRoot()

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      models: { language: [gpt, sonnet] },
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.models?.language.default.model).toBe(gpt)
  })

  test("leaves the catalog absent when models are not configured", async () => {
    const projectRoot = await createTempProjectRoot()

    const sixb = await createSixb({ projectRoot, ontologies: [Room], ...createTestRuntimeDeps() })

    expect(sixb.definitions.models).toBeUndefined()
  })

  test("rejects an agent whose model is outside the configured catalog", async () => {
    const projectRoot = await createTempProjectRoot()
    const stray = defineAgent("stray", {
      name: "Stray",
      model: testModel("openai", "gpt-5.4"),
      instructions: "Answer questions.",
    })

    // Proven by removal: drop the `validateAgentModelReferences` call in `resolveDefinitions` and
    // this fails. Matched on the message because a bare `RuntimeError` is also what an unrelated
    // startup failure in a temp project throws.
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        agents: [stray],
        models: { language: [gpt] },
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow(/Agent 'stray' uses unknown language model 'openai\/gpt-5\.4'/)
  })

  test("accepts an agent whose model is in the configured catalog", async () => {
    const projectRoot = await createTempProjectRoot()
    const known = defineAgent("known", {
      name: "Known",
      model: gpt,
      instructions: "Answer questions.",
    })

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      agents: [known],
      models: { language: [gpt] },
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.agents.getById("known")?.name).toBe("Known")
  })
})
