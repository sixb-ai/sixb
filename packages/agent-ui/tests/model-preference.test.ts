import { expect, test } from "bun:test"
import { listModelsOptions } from "@sixb/client/hooks"
import { MODEL_REASONING_LEVELS } from "@sixb/core/models"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { useAgentConversation } from "../src/hooks/useAgentConversation"
import type { LanguageModel } from "../src/types"

test("restores the selected model with every supported saved reasoning level", () => {
  // Removal proof: restore the old local allowlist in useAgentConversation; max resets to default.
  const model: LanguageModel = {
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    name: "Opus",
    publisher: { id: "anthropic", name: "Anthropic" },
    isDefault: false,
    capabilities: { input: ["text"], output: ["text"] },
    reasoningLevels: [...MODEL_REASONING_LEVELS],
  }
  const queryClient = new QueryClient()
  queryClient.setQueryData(listModelsOptions().queryKey, {
    language: [{ ...model, modelId: "default-model", isDefault: true }, model],
  })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  let saved: string
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => (key === "sixb.agent-ui.model-preference" ? saved : null),
      },
    },
  })
  function Selection() {
    const { selectedModel, selectedReasoning } = useAgentConversation({
      threadId: null,
      onThreadCreated: () => {},
    })
    return createElement("span", null, `${selectedModel?.modelId}:${selectedReasoning}`)
  }
  try {
    for (const reasoning of [...MODEL_REASONING_LEVELS, "invalid"]) {
      saved = JSON.stringify({
        model: { provider: model.provider, modelId: model.modelId },
        reasoning,
      })
      const html = renderToStaticMarkup(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Selection))
      )
      expect(html).toContain(
        reasoning === "invalid" ? "default-model:provider-default" : `${model.modelId}:${reasoning}`
      )
    }
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    queryClient.clear()
  }
})
