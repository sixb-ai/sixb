import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSixb, defineAgentTool, defineObjectType, prop } from "../src"
import {
  createModelCatalog,
  defineLanguageModel,
  defineLanguageModelLabel,
  LANGUAGE_MODEL_TIERS,
  type LanguageModel,
} from "../src/models"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// Removal proof: omit publisher, via or maxInputTokens from defineLanguageModel's output or
// validation, or retain the caller's publisher object so it can mutate after definition.
test("model definitions validate and snapshot display metadata and input limits", () => {
  const publisher = { id: "openai", name: "OpenAI" }
  const input = {
    kind: "language" as const,
    providerId: "host",
    modelId: "deployment",
    capabilities: {},
    publisher,
    via: "Azure AI Foundry",
    contextWindow: 200_000,
    maxInputTokens: 180_000,
  }
  const definition = defineLanguageModel(input)
  publisher.name = "Changed"
  expect(definition).toMatchObject({
    publisher: { id: "openai", name: "OpenAI" },
    via: "Azure AI Foundry",
    contextWindow: 200_000,
    maxInputTokens: 180_000,
  })
  expect(Object.isFrozen(definition.publisher)).toBe(true)
  for (const [invalid, field] of [
    [{ publisher: { id: "", name: "OpenAI" } }, "publisher"],
    [{ publisher: { id: " openai", name: "OpenAI" } }, "publisher"],
    [{ publisher: { id: "openai", name: "" } }, "publisher"],
    [{ via: "" }, "via"],
    ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map(
      (maxInputTokens) => [{ maxInputTokens }, "maxInputTokens"] as const
    ),
  ] as const) {
    expect(() => defineLanguageModel({ ...input, ...invalid })).toThrow(field)
  }
})

// Removal proof: drop the trim check, or return the binding's options as they are.
test("a model label keeps only a nonempty trimmed name and description", () => {
  const options = { name: "GPT", description: "A second opinion.", reasoning: "low" }

  expect(defineLanguageModelLabel(options, "[Provider]")).toEqual({
    name: "GPT",
    description: "A second opinion.",
  })
  expect(defineLanguageModelLabel({}, "[Provider]")).toEqual({})

  for (const [invalid, field] of [
    [{ name: "" }, "name"],
    [{ name: " GPT" }, "name"],
    [{ description: "A second opinion.\n" }, "description"],
    [{ description: 42 as unknown as string }, "description"],
  ] as const) {
    expect(() => defineLanguageModelLabel(invalid, "[Provider]")).toThrow(
      `[Provider] ${field} must be a nonempty trimmed string.`
    )
  }
})

const tempRoots = new Set<string>()

/** The catalog never calls the model, so a minimal owned-contract stub is enough. */
function testModel(providerId: string, modelId: string): LanguageModel {
  return {
    providerId,
    modelId,
    definition: defineLanguageModel({ kind: "language", providerId, modelId, capabilities: {} }),
    async stream() {
      throw new Error("Catalog tests do not run inference.")
    },
  }
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
  test("indexes bindings in configured order by provider and model id", () => {
    // Proven by removal: a lookup keyed by `${provider}/${modelId}` makes `slashedProvider` and
    // `slashedModel` collide; one keyed by modelId alone makes `direct` replace `gpt`.
    const direct = testModel("openai", "openai/gpt-5.4")
    const slashedProvider = testModel("a/b", "c")
    const slashedModel = testModel("a", "b/c")
    const catalog = createModelCatalog({
      language: [gpt, sonnet, direct, slashedProvider, slashedModel],
    })

    expect(catalog.language.default.model).toBe(gpt)
    expect(catalog.language.list().map(({ provider, modelId }) => ({ provider, modelId }))).toEqual(
      [
        { provider: "gateway", modelId: "openai/gpt-5.4" },
        { provider: "gateway", modelId: "anthropic/claude-sonnet-4.6" },
        { provider: "openai", modelId: "openai/gpt-5.4" },
        { provider: "a/b", modelId: "c" },
        { provider: "a", modelId: "b/c" },
      ]
    )
    expect(
      catalog.language.getByRef({ provider: "gateway", modelId: "openai/gpt-5.4" })?.model
    ).toBe(gpt)
    expect(
      catalog.language.getByRef({ provider: "openai", modelId: "openai/gpt-5.4" })?.model
    ).toBe(direct)
    expect(catalog.language.getByRef({ provider: "a/b", modelId: "c" })?.model).toBe(
      slashedProvider
    )
    expect(catalog.language.getByRef({ provider: "a", modelId: "b/c" })?.model).toBe(slashedModel)
    expect(catalog.language.getByRef({ provider: "gateway", modelId: "openai/gpt-9" })).toBeNull()
    expect(Object.isFrozen(catalog.language.list())).toBe(true)
    // The catalog freezes its own entries, never the provider-owned model.
    expect(Object.isFrozen(gpt)).toBe(false)
  })

  const reasoningEfforts: LanguageModel = {
    ...gpt,
    definition: defineLanguageModel({
      ...gpt.definition,
      capabilities: { reasoning: { efforts: ["low", "high"] } },
    }),
  }
  const outputLimited: LanguageModel = {
    ...gpt,
    definition: defineLanguageModel({ ...gpt.definition, maxOutputTokens: 32_000 }),
  }
  // Both sides carry the bad identity, so only the binding's own identifier check can reject it.
  const identity = (field: "providerId" | "modelId", value: string) => ({
    ...gpt,
    [field]: value,
    definition: { ...gpt.definition, [field]: value },
  })

  // Proven by removal: drop the `byRef.has(key)` guard in `models/catalog-index.ts` (the second
  // entry replaces the first in the lookup), the `defaultEntry === undefined` guard (`default`
  // reads as undefined), `assertDefaultReasoning` or `assertMaxOutputTokens` from the catalog's
  // validator.
  test.each([
    [
      "a duplicate binding",
      [gpt, testModel("gateway", "openai/gpt-5.4")],
      /Duplicate language model 'gateway\/openai\/gpt-5\.4'/,
    ],
    ["an empty catalog", [], /'models.language' needs at least one model/],
    ["a non-array catalog", null, /'models.language' must be an array/],
    ["a binding without stream", [{ ...gpt, stream: undefined }], /'stream' to be a function/],
    ["a binding without a definition", [{ ...gpt, definition: undefined }], /models.language\[0\]/],
    ["an empty providerId", [identity("providerId", "")], /'provider' to be a non-empty string/],
    ["a padded providerId", [identity("providerId", " gateway")], /'provider' not to have/],
    ["an empty modelId", [identity("modelId", "")], /'modelId' to be a non-empty string/],
    ["a padded modelId", [identity("modelId", "openai/gpt-5.4 ")], /'modelId' not to have/],
    [
      "a definition for another model",
      [{ ...gpt, definition: { ...gpt.definition, modelId: "other" } }],
      /definition identity does not match the binding/,
    ],
    [
      "a budget default reasoning",
      [{ ...gpt, defaultReasoning: { budgetTokens: 1_000 } }],
      /expected 'defaultReasoning' to be one of/,
    ],
    [
      "an unknown default reasoning",
      [{ ...gpt, defaultReasoning: "extreme" }],
      /expected 'defaultReasoning' to be one of/,
    ],
    [
      "a default reasoning the model declares it cannot use",
      [{ ...reasoningEfforts, defaultReasoning: "max" }],
      "[Sixb] Invalid language model at 'models.language[0]': default reasoning 'max' cannot be used: reasoning effort 'max' is not supported.",
    ],
    [
      "an output limit above the model maximum",
      [{ ...outputLimited, maxOutputTokens: 32_001 }],
      "[Sixb] Invalid language model at 'models.language[0]': 'maxOutputTokens' (32001) exceeds the model maximum (32000).",
    ],
    [
      "an output limit that is not a positive integer",
      [{ ...gpt, maxOutputTokens: 1.5 }],
      /expected 'maxOutputTokens' to be a positive safe integer/,
    ],
  ] as const)("rejects %s", (_case, language, error) => {
    expect(() =>
      createModelCatalog({ language } as unknown as Parameters<typeof createModelCatalog>[0])
    ).toThrow(error)
  })

  test("keeps a default reasoning the model supports or does not declare", () => {
    const supported = createModelCatalog({
      language: [{ ...reasoningEfforts, defaultReasoning: "high" }, sonnet],
    })
    expect(supported.language.default.model.defaultReasoning).toBe("high")
    expect(supported.language.list()[1]?.model.defaultReasoning).toBeUndefined()
    // Undeclared capabilities are resolved later; the provider falls back when needed.
    expect(
      createModelCatalog({ language: [{ ...gpt, defaultReasoning: "max" }] }).language.default.model
        .defaultReasoning
    ).toBe("max")
  })

  test("keeps an output limit up to the model maximum", () => {
    const catalog = createModelCatalog({
      language: [{ ...outputLimited, maxOutputTokens: 32_000 }],
    })

    expect(catalog.language.default.model.maxOutputTokens).toBe(32_000)
  })

  const flash = testModel("gateway", "deepseek/deepseek-v4.1-flash")
  const opus = testModel("gateway", "anthropic/claude-opus-5.5")

  test("lists tiers light, standard then heavy, the default being standard's first model", () => {
    // Proven by removal: list the tiers in the order they are written, or keep the first entry
    // as the default.
    const catalog = createModelCatalog({
      language: { heavy: [opus, gpt], standard: sonnet, light: flash },
    })

    expect(catalog.language.list().map(({ tier, modelId }) => [tier, modelId])).toEqual([
      ["light", "deepseek/deepseek-v4.1-flash"],
      ["standard", "anthropic/claude-sonnet-4.6"],
      ["heavy", "anthropic/claude-opus-5.5"],
      ["heavy", "openai/gpt-5.4"],
    ])
    expect(catalog.language.default.model).toBe(sonnet)
    expect(catalog.language.getByRef({ provider: "gateway", modelId: "openai/gpt-5.4" })).toEqual({
      provider: "gateway",
      modelId: "openai/gpt-5.4",
      model: gpt,
      tier: "heavy",
    })
    expect(Object.isFrozen(catalog.language.list()[0])).toBe(true)
  })

  test("names the tiers it configures, in tier order, and none for a list", () => {
    // Proven by removal: list the tiers as written, or every tier whatever is configured.
    const tiers = createModelCatalog({ language: { heavy: opus, standard: sonnet } })
    const list = createModelCatalog({ language: [gpt, sonnet] })

    expect(tiers.language.tiers).toEqual(["standard", "heavy"])
    expect(list.language.tiers).toEqual([])
  })

  test("gives a tier its first model, and standard's first model to a tier left out", () => {
    // Proven by removal: return the default for every tier, or the tier's last model.
    const tiers = createModelCatalog({ language: { standard: [sonnet, gpt], heavy: opus } })

    expect(tiers.language.getByTier("heavy").model).toBe(opus)
    expect(tiers.language.getByTier("standard").model).toBe(sonnet)
    expect(tiers.language.getByTier("light").model).toBe(sonnet)

    // A list has no tiers: every tier gives its first model, and no entry carries a tier.
    const list = createModelCatalog({ language: [gpt, sonnet] })

    for (const tier of LANGUAGE_MODEL_TIERS) {
      expect(list.language.getByTier(tier).model).toBe(gpt)
    }
    expect(list.language.list().some((entry) => "tier" in entry)).toBe(false)
  })

  // Proven by removal: drop the `standard` check (the default falls back to light), the unknown
  // key check (`medium` is ignored), the empty tier check or the tier's path in the error.
  test.each([
    [
      "tiers without standard",
      { light: flash },
      "[Sixb] 'models.language' tiers need 'standard': its first model is the project default.",
    ],
    [
      "an unknown tier",
      { standard: sonnet, medium: gpt },
      "[Sixb] Unknown model tier 'medium' in 'models.language'. Use light, standard or heavy, or pass an array of models.",
    ],
    [
      "an empty tier",
      { standard: sonnet, heavy: [] },
      "[Sixb] 'models.language.heavy' needs at least one model.",
    ],
    [
      "a model in two tiers",
      { standard: sonnet, heavy: [opus, sonnet] },
      /Duplicate language model 'gateway\/anthropic\/claude-sonnet-4\.6'/,
    ],
    [
      "an invalid model in a tier's list",
      { standard: sonnet, heavy: [opus, { ...gpt, stream: undefined }] },
      "[Sixb] Invalid language model at 'models.language.heavy[1]': expected 'stream' to be a function.",
    ],
    [
      "an invalid model alone in a tier",
      { standard: { ...sonnet, stream: undefined } },
      "[Sixb] Invalid language model at 'models.language.standard': expected 'stream' to be a function.",
    ],
  ] as const)("rejects %s", (_case, language, error) => {
    expect(() =>
      createModelCatalog({ language } as unknown as Parameters<typeof createModelCatalog>[0])
    ).toThrow(error)
  })
})

describe("createSixb models", () => {
  test("configures the project Agent from the default language model", async () => {
    const projectRoot = await createTempProjectRoot()

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      models: { language: [gpt, sonnet] },
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.models?.language?.default.model).toBe(gpt)
    expect(createTestSixb(sixb).agent.get()).toEqual({
      name: "Sixb",
      model: { provider: gpt.providerId, modelId: gpt.modelId },
    })
  })

  // Removal proof: let getAgent() describe the Agent when no language model is configured.
  test("leaves the catalog absent when models are not configured", async () => {
    const projectRoot = await createTempProjectRoot()

    const sixb = await createSixb({ projectRoot, ontologies: [Room], ...createTestRuntimeDeps() })

    expect(sixb.definitions.models).toBeUndefined()
    expect(createTestSixb(sixb).agent.get()).toBeNull()
  })

  test("rejects retired agents configuration even from JavaScript", async () => {
    const projectRoot = await createTempProjectRoot()
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        ...createTestRuntimeDeps(),
        // @ts-expect-error retired configuration must also fail at runtime
        agents: [],
      })
    ).rejects.toThrow(/Agent definitions are no longer supported/)
  })

  test("validates project tools as one catalog", async () => {
    const projectRoot = await createTempProjectRoot()
    const first = defineAgentTool("lookup")
      .description("Look up one source.")
      .input({ query: "string" })
      .run(() => ({}))
    const second = defineAgentTool("lookup")
      .description("Look up another source.")
      .input({ query: "string" })
      .run(() => ({}))

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        models: { language: [gpt] },
        tools: [first, second],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow(/Project tools contain duplicate tool name 'lookup'/)
  })
})
