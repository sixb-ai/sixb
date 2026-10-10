import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ModelControls } from "../src/components/ModelControls"
import {
  preferenceWithoutReasoning,
  preferenceWithReasoning,
  resolveModelSelection,
} from "../src/modelSelection"
import type { LanguageModel } from "../src/types"

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

test("follows the project defaults without asking for them", () => {
  // Proven by removal: always build `request` from the displayed model and reasoning.
  expect(resolveModelSelection(models, null)).toEqual({ model: fast, reasoning: "low" })
})

test("a chosen model starts from its own default reasoning, left to the server", () => {
  expect(resolveModelSelection(models, { model: { provider: "test", modelId: "deep" } })).toEqual({
    model: deep,
    reasoning: "high",
    request: { model: { provider: "test", modelId: "deep" } },
  })
})

test("sends an explicitly chosen reasoning the model supports", () => {
  const preference = { model: { provider: "test", modelId: "deep" }, reasoning: "low" } as const
  expect(resolveModelSelection(models, preference).request).toEqual(preference)
  expect(resolveModelSelection(models, { ...preference, reasoning: "max" }).request).toEqual({
    model: preference.model,
  })
})

test("an effort chosen without a model follows whichever model is the default", () => {
  // Proven by removal: resolve the reasoning only against `preferred`; the effort is then dropped.
  const preference = { reasoning: "high" } as const
  expect(resolveModelSelection(models, preference)).toEqual({
    model: fast,
    reasoning: "high",
    request: { reasoning: "high" },
  })
  const newDefault = [
    { ...deep, isDefault: true },
    { ...fast, isDefault: false },
  ]
  expect(resolveModelSelection(newDefault, preference).model?.modelId).toBe("deep")
  // A default that cannot use it falls back to its own default, and the request stays empty.
  const plain = model("plain", { isDefault: true, reasoningLevels: ["provider-default", "low"] })
  expect(resolveModelSelection([plain], preference)).toEqual({
    model: plain,
    reasoning: "provider-default",
  })
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

test("falls back to the defaults when the chosen model left the catalog", () => {
  expect(resolveModelSelection(models, { model: { provider: "test", modelId: "gone" } })).toEqual({
    model: fast,
    reasoning: "low",
  })
})

test("shows the provider default when a default level is not offered", () => {
  const plain = model("plain", { isDefault: true, defaultReasoning: "max" })
  expect(resolveModelSelection([plain], null).reasoning).toBe("provider-default")
  expect(resolveModelSelection([], null)).toEqual({})
})

test("names the defaults the composer follows", () => {
  const render = (usingDefault: boolean, selectedModel: LanguageModel) =>
    renderToStaticMarkup(
      createElement(ModelControls, {
        models,
        selectedModel,
        selectedReasoning: "low",
        usingDefault,
        onSelectModel: () => {},
        onSelectReasoning: () => {},
        onResetToDefault: () => {},
      })
    )
  expect(render(true, fast)).toContain('title="Default · fast · Low"')
  expect(render(false, deep)).toContain('title="deep"')
})
