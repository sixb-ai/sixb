import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ComposerSettings } from "../src/agent/components/composer-settings"
import {
  type ModelPreference,
  preferenceWithoutReasoning,
  preferenceWithReasoning,
  type ResolvedModelSelection,
  resolveModelSelection,
} from "../src/agent/model-selection"
import type { LanguageModel } from "../src/agent/types"

function model(modelId: string, overrides: Partial<LanguageModel> = {}): LanguageModel {
  return {
    provider: "test",
    modelId,
    name: modelId,
    publisher: { id: "test", name: "Test" },
    isDefault: false,
    capabilities: { input: ["text"], output: ["text"], reasoning: true },
    reasoningLevels: ["provider-default", "low", "high"],
    ...overrides,
  }
}

const fast = model("fast", { isDefault: true, defaultReasoning: "low" })
const deep = model("deep", { defaultReasoning: "high" })
const models = [deep, fast]

const deepRef = { provider: "test", modelId: "deep" } as const
const newDefault = [
  { ...deep, isDefault: true },
  { ...fast, isDefault: false },
]
const plain = model("plain", { isDefault: true, reasoningLevels: ["provider-default", "low"] })
const unofferedDefault = model("plain", { isDefault: true, defaultReasoning: "max" })
const tiers = [
  { ...fast, tier: "standard" as const },
  { ...deep, tier: "heavy" as const },
]

test.each<[string, readonly LanguageModel[], ModelPreference | null, ResolvedModelSelection]>([
  // Proven by removal: always build `request` from the displayed model and reasoning.
  [
    "follows the project defaults without asking for them",
    models,
    null,
    { model: fast, reasoning: "low" },
  ],
  [
    "a chosen model starts from its own default reasoning, left to the server",
    models,
    { model: deepRef },
    { model: deep, reasoning: "high", request: { model: deepRef } },
  ],
  [
    "sends an explicitly chosen reasoning the model supports",
    models,
    { model: deepRef, reasoning: "low" },
    { model: deep, reasoning: "low", request: { model: deepRef, reasoning: "low" } },
  ],
  [
    "leaves a reasoning the chosen model does not offer to the server",
    models,
    { model: deepRef, reasoning: "max" },
    { model: deep, reasoning: "high", request: { model: deepRef } },
  ],
  // Proven by removal: resolve the reasoning only against `preferred`; the effort is then dropped.
  [
    "an effort chosen without a model follows the default model",
    models,
    { reasoning: "high" },
    { model: fast, reasoning: "high", request: { reasoning: "high" } },
  ],
  [
    "an effort chosen without a model follows a new default model",
    newDefault,
    { reasoning: "high" },
    { model: newDefault[0], reasoning: "high", request: { reasoning: "high" } },
  ],
  [
    "an effort the default cannot use falls back to its own default, and the request stays empty",
    [plain],
    { reasoning: "high" },
    { model: plain, reasoning: "provider-default" },
  ],
  [
    "falls back to the defaults when the chosen model left the catalog",
    models,
    { model: { provider: "test", modelId: "gone" } },
    { model: fast, reasoning: "low" },
  ],
  [
    "shows the provider default when a default level is not offered",
    [unofferedDefault],
    null,
    { model: unofferedDefault, reasoning: "provider-default" },
  ],
  ["resolves nothing from an empty catalog", [], null, {}],
  // Proven by removal: drop the tiers check in resolveModelSelection; Auto shows the default.
  ["with tiers, nothing chosen is Auto, which asks for nothing", tiers, null, { auto: true }],
  ["with tiers, a reasoning alone pins no model", tiers, { reasoning: "high" }, { auto: true }],
  [
    "with tiers, a chosen model is pinned, with its reasoning",
    tiers,
    { model: deepRef, reasoning: "low" },
    { model: tiers[1], reasoning: "low", request: { model: deepRef, reasoning: "low" } },
  ],
  [
    "with tiers, a pinned model that left the catalog is Auto again",
    tiers,
    { model: { provider: "test", modelId: "gone" } },
    { auto: true },
  ],
])("%s", (_name, catalog, preference, expected) => {
  expect(resolveModelSelection(catalog, preference)).toEqual(expected)
})

test("moving only the effort never pins the default model, and resetting forgets it", () => {
  // Proven by removal: store `selection.model` in preferenceWithReasoning.
  const following = resolveModelSelection(models, null)
  expect(preferenceWithReasoning(following, "high")).toEqual({ reasoning: "high" })
  expect(
    preferenceWithoutReasoning(resolveModelSelection(models, { reasoning: "high" }))
  ).toBeNull()
  const chosen = resolveModelSelection(models, { model: { provider: "test", modelId: "deep" } })
  expect(preferenceWithReasoning(chosen, "low")).toEqual({
    model: { provider: "test", modelId: "deep" },
    reasoning: "low",
  })
  expect(preferenceWithoutReasoning(chosen)).toEqual({
    model: { provider: "test", modelId: "deep" },
  })
})

test("names the defaults the composer follows", () => {
  const render = (usingDefaultModel: boolean, selectedModel: LanguageModel) =>
    renderToStaticMarkup(
      createElement(ComposerSettings, {
        models,
        selectedModel,
        selectedReasoning: "low",
        usingDefaultModel,
        onSelectModel: () => {},
        onSelectReasoning: () => {},
        onResetModelSelection: () => {},
      })
    )
  expect(render(true, fast)).toContain('title="Default · fast · Low"')
  expect(render(false, deep)).toContain('title="deep · Low"')
})

test("with tiers the chip says Auto while no model is pinned", () => {
  // Removal proof: drop the tiers branch from ComposerSettings; it shows "Default model".
  const html = renderToStaticMarkup(
    createElement(ComposerSettings, {
      models: tiers,
      onSelectModel: () => {},
      onSelectReasoning: () => {},
      onResetModelSelection: () => {},
    })
  )
  expect(html).toContain('aria-label="Auto. Change model and permissions"')
  expect(html).not.toContain("Default model")
})
