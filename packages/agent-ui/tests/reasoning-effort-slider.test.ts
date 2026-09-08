import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ReasoningEffortSlider } from "../src/components/ReasoningEffortSlider"
import type { LanguageModel } from "../src/types"

function render(levels: LanguageModel["reasoningLevels"]): string {
  const model: LanguageModel = {
    provider: "test",
    modelId: "model",
    name: "Model",
    isDefault: true,
    publisher: { id: "test", name: "Test" },
    capabilities: { input: ["text"], output: ["text"], reasoning: true },
    reasoningLevels: levels,
  }
  return renderToStaticMarkup(
    createElement(ReasoningEffortSlider, {
      model,
      value: "provider-default",
      onChange: () => {},
    })
  )
}

test("hides the slider when the model has no effort levels at Low or above", () => {
  // Regression proof: restore the none stop in the slider filter; it becomes visible again.
  const html = render(["provider-default", "none"])
  expect(html).toContain('hidden=""')
  expect(html).toContain('aria-label="Reasoning effort"')
})

test("uses only the provider-declared effort stops, including Max", () => {
  const html = render(["provider-default", "high", "max"])
  expect(html).toContain('min="0" max="1"')
  expect(html.match(/class="sixb-reasoning-stop"/g)).toHaveLength(2)
})
