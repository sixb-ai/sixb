import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import { createSixb, defineAgent, defineObjectType, prop } from "../src"
import { createModelCatalog } from "../src/models"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const tempRoots = new Set<string>()

/** The catalog only reads `provider` and `modelId`, so a conforming stub is enough. */
function testModel(provider: string, modelId: string): LanguageModelV4 {
  return { specificationVersion: "v4", provider, modelId } as LanguageModelV4
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
  test("derives an entry reference from provider and modelId", () => {
    const catalog = createModelCatalog({ language: [gpt] })

    expect(catalog.language.list().map((entry) => entry.ref)).toEqual(["gateway/openai/gpt-5.4"])
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

    expect(catalog.language.default.ref).toBe("gateway/openai/gpt-5.4")
  })

  test("resolves an entry by reference and returns null for an unknown one", () => {
    const catalog = createModelCatalog({ language: [gpt] })

    expect(catalog.language.getById("gateway/openai/gpt-5.4")?.model).toBe(gpt)
    expect(catalog.language.getById("gateway/openai/gpt-9")).toBeNull()
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

    expect(catalog.language.list().map((entry) => entry.ref)).toEqual([
      "openai.chat/gpt-5.4",
      "openai.responses/gpt-5.4",
    ])
  })

  test("rejects an empty language catalog", () => {
    // Proven by removal: drop the `defaultEntry === undefined` guard and this fails, because
    // `default` then reads as undefined instead of the catalog refusing to exist.
    expect(() => createModelCatalog({ language: [] })).toThrow(
      /'models.language' needs at least one model/
    )
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

    expect(sixb.definitions.models?.language.default.ref).toBe("gateway/openai/gpt-5.4")
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
