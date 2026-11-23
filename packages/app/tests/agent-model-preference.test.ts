import { expect, test } from "bun:test"
import { client } from "@sixb/client"
import { listModelsOptions } from "@sixb/client/hooks"
import { MODEL_REASONING_LEVELS } from "@sixb/core/models"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Composer } from "../src/agent/components/composer"
import { threadQueryOptions } from "../src/agent/hooks/thread-queries"
import {
  type AgentConversation,
  useAgentConversation,
} from "../src/agent/hooks/use-agent-conversation"
import type { AgentRun, LanguageModel } from "../src/agent/types"

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
    image: [],
    audio: { speech: [], transcription: [] },
    capabilities: { run: false },
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

test("with tiers, a thread without its own choice is Auto, not the browser's choice", async () => {
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
    value: {
      localStorage: {
        getItem: (key: string) =>
          key === "sixb.agent-ui.model-preference" ? JSON.stringify(remembered) : null,
      },
    },
  })

  // Removal proof: read a thread's model as `modelPins[threadId] ?? modelPreference`; the tiered
  // message asks for Opus and the thread's choice is Opus, not Auto.
  const chat = async (language: readonly LanguageModel[]) => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(listModelsOptions().queryKey, {
      language: [...language],
      image: [],
      audio: { speech: [], transcription: [] },
      capabilities: { run: false },
    })
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

    return {
      modelChoice: conversation?.modelChoice,
      // The chip names the model it runs: the pinned one, or Auto.
      picker: html.includes('aria-label="Opus, High'),
      auto: html.includes('aria-label="Auto'),
      posted,
    }
  }

  try {
    expect(await chat(list)).toEqual({
      modelChoice: expect.objectContaining({ modelId: opus.modelId }),
      picker: true,
      auto: false,
      posted: [expect.objectContaining(remembered)],
    })

    const tiered = await chat(tiers)
    expect(tiered.modelChoice).toBe("auto")
    expect(tiered.picker).toBe(false)
    expect(tiered.auto).toBe(true)
    expect(tiered.posted).toEqual([expect.objectContaining({ text: "Why did margin drop?" })])
    expect(tiered.posted[0]).not.toHaveProperty("model")
    expect(tiered.posted[0]).not.toHaveProperty("reasoning")
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    client.setConfig(originalConfig)
  }
})

test("with tiers, a thread this browser pinned nothing in opens on the model its requester chose", async () => {
  const opus: LanguageModel = {
    provider: "anthropic",
    modelId: "claude-opus-5-5",
    name: "Opus",
    publisher: { id: "anthropic", name: "Anthropic" },
    isDefault: false,
    capabilities: { input: ["text"], output: ["text"] },
    reasoningLevels: ["provider-default", "low", "high"],
    tier: "heavy",
  }
  const sonnet: LanguageModel = {
    ...opus,
    modelId: "claude-sonnet-5-5",
    name: "Sonnet",
    isDefault: true,
    tier: "standard",
  }
  const chosen = {
    model: { provider: opus.provider, modelId: opus.modelId },
    reasoning: "high" as const,
  }
  const run = (fields: Partial<AgentRun>): AgentRun => ({
    id: "run_1",
    projectId: "project",
    kind: "conversation",
    threadId: "thr_1",
    triggerMessageId: "msg_1",
    status: "succeeded",
    attempt: 1,
    streamId: "agents.runs.run_1",
    createdAt: "2026-11-22T10:00:00.000Z",
    ...chosen,
    ...fields,
  })

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
  let pins: string | null = null
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => (key === "sixb.agent-ui.model-pins" ? pins : null),
      },
    },
  })

  // Guard proof: read a thread's model as `threadPin ?? null`; the thread opened in a browser that
  // pinned nothing shows Auto and its next message asks for nothing. Drop the "auto" pin from
  // readModelPins; choosing Auto in the thread falls back to Opus.
  const chat = async (latest: AgentRun, language: readonly LanguageModel[] = [sonnet, opus]) => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(listModelsOptions().queryKey, {
      language: [...language],
      image: [],
      audio: { speech: [], transcription: [] },
      capabilities: { run: false },
    })
    queryClient.setQueryData(threadQueryOptions("thr_1").runs.queryKey, {
      runs: [latest],
      hasMore: false,
      total: 1,
    })
    let conversation: AgentConversation | undefined

    function Chat() {
      conversation = useAgentConversation({ threadId: "thr_1", onThreadCreated: () => {} })
      return createElement(Composer, conversation.composerProps)
    }

    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Chat))
    )
    posted.length = 0
    await conversation?.send("Go on", [], [])
    queryClient.clear()

    const [body] = posted as { model?: unknown; reasoning?: unknown }[]
    return {
      picker: html.match(/aria-label="(Auto|Opus, High|Sonnet)/)?.[1],
      asked: body && { model: body.model, reasoning: body.reasoning },
    }
  }

  try {
    expect(await chat(run({ pinned: true }))).toEqual({ picker: "Opus, High", asked: chosen })

    // A turn Sixb picked the model of leaves the thread on Auto, as does a model the project no
    // longer offers.
    const auto = { picker: "Auto", asked: { model: undefined, reasoning: undefined } }
    expect(await chat(run({}))).toEqual(auto)
    expect(await chat(run({ pinned: true }), [sonnet])).toEqual(auto)

    // This browser's choice in the thread wins, Auto included.
    pins = JSON.stringify({ thr_1: "auto" })
    expect(await chat(run({ pinned: true }))).toEqual(auto)
    pins = JSON.stringify({
      thr_1: { model: { provider: sonnet.provider, modelId: sonnet.modelId } },
    })
    expect(await chat(run({ pinned: true }))).toEqual({
      picker: "Sonnet",
      asked: {
        model: { provider: sonnet.provider, modelId: sonnet.modelId },
        reasoning: undefined,
      },
    })
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    client.setConfig(originalConfig)
  }
})
