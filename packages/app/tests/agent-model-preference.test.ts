import { expect, test } from "bun:test"
import { client } from "@sixb/client"
import { listModelsOptions } from "@sixb/client/hooks"
import { MODEL_REASONING_LEVELS } from "@sixb/core/models"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Composer } from "../src/agent/components/composer"
import {
  type AgentConversation,
  useAgentConversation,
} from "../src/agent/hooks/use-agent-conversation"
import type { LanguageModel } from "../src/agent/types"

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

test("with tiers, a remembered model is neither shown nor asked for", async () => {
  const opus: LanguageModel = {
    provider: "anthropic",
    modelId: "claude-opus-5-5",
    name: "Opus",
    publisher: { id: "anthropic", name: "Anthropic" },
    isDefault: false,
    capabilities: { input: ["text"], output: ["text"] },
    reasoningLevels: ["provider-default", "low", "high"],
  }
  const sonnet: LanguageModel = { ...opus, modelId: "claude-sonnet-5-5", isDefault: true }
  const list = [sonnet, opus]
  const tiers = [
    { ...sonnet, tier: "standard" as const },
    { ...opus, tier: "heavy" as const },
  ]
  const remembered = {
    model: { provider: opus.provider, modelId: opus.modelId },
    reasoning: "high",
  }

  const posted: unknown[] = []
  const originalConfig = client.getConfig()
  client.setConfig({
    baseUrl: "https://api.sixb.test",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "POST") posted.push(await request.json())
        return Response.json({ error: "[Sixb] refused" }, { status: 409 })
      },
      { preconnect: fetch.preconnect }
    ),
  })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => JSON.stringify(remembered) } },
  })

  // Removal proof: drop the tiers check from resolveModelSelection, the tiered message asks for
  // Opus; drop it from the conversation's composer props, the tiered composer shows the picker.
  const chat = async (language: readonly LanguageModel[]) => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(listModelsOptions().queryKey, { language })
    let conversation: AgentConversation | undefined

    function Chat() {
      conversation = useAgentConversation({ threadId: "thr_1", onThreadCreated: () => {} })
      return createElement(Composer, conversation.composerProps)
    }

    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Chat))
    )
    posted.length = 0
    await conversation?.send("Why did margin drop?", [], [])
    queryClient.clear()

    return { picker: html.includes('aria-label="Choose model and reasoning effort"'), posted }
  }

  try {
    expect(await chat(list)).toEqual({
      picker: true,
      posted: [expect.objectContaining(remembered)],
    })

    const tiered = await chat(tiers)
    expect(tiered.picker).toBe(false)
    expect(tiered.posted).toEqual([expect.objectContaining({ text: "Why did margin drop?" })])
    expect(tiered.posted[0]).not.toHaveProperty("model")
    expect(tiered.posted[0]).not.toHaveProperty("reasoning")
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    client.setConfig(originalConfig)
  }
})
