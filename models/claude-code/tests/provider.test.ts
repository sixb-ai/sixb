import { describe, expect, test } from "bun:test"
import { claudeCode, createClaudeCode } from "../src"
import { environment, modelInfoDefinition, reasoningOptions } from "../src/provider"

describe("claudeCode", () => {
  test("binds a model through Claude Code before its model list loads", () => {
    const model = claudeCode("opus", { name: "Opus (Claude Code)", reasoning: "high" })

    expect(model.providerId).toBe("claude-code")
    expect(model.defaultReasoning).toBe("high")
    expect(model.definition).toMatchObject({
      modelId: "opus",
      name: "Opus (Claude Code)",
      via: "Claude Code",
      capabilities: { localTools: true, nativeStructuredOutput: true },
    })
  })

  test("runs on the computer of whoever runs a turn, named after the alias it binds", () => {
    const model = claudeCode("sonnet")

    expect(model.runsOnComputers).toBe(true)
    expect(model.definition.name).toBe("Sonnet")
  })

  // Guard proof: drop costEstimator from ClaudeCodeLanguageModel; a project with a cost limit then
  // refuses every call with ai.usage_limit_unavailable, since no reservation can be priced.
  test("prices each call at nothing, so a cost limit can admit it", () => {
    const model = claudeCode("sonnet")

    expect(
      model.costEstimator?.estimateReservation?.({ inputTokens: 50_000, outputTokens: 8_000 })
    ).toEqual({ currency: "USD", amountNanos: "0" })
    expect(
      // A call's usage as Claude Code reports it: its session prompt cached for an hour.
      model.costEstimator?.estimate({
        usage: {
          inputTokens: 13_037,
          outputTokens: 69,
          uncachedInputTokens: 2,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 13_035,
          cacheWrite5mInputTokens: 0,
          cacheWrite1hInputTokens: 13_035,
        },
      })
    ).toMatchObject({ status: "rated", money: { currency: "USD", amountNanos: "0" } })
  })

  test("refuses a call made where the project runs when it runs only on computers", async () => {
    const provider = createClaudeCode({ computersOnly: true })

    const refused = await provider("opus")
      .stream({
        callId: "call-1",
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        tools: [],
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error)

    expect(refused).toMatchObject({ code: "computers_only" })
    // Its model list never starts Claude Code: it is the definitions the project supplies.
    expect(await provider.catalog.list()).toEqual([])
  })

  test("rejects options it cannot use", () => {
    expect(() => claudeCode(" ")).toThrow("Model id must not be empty")
    expect(() => createClaudeCode({ executable: "" })).toThrow("executable")
  })

  test("resolves offline to the definition supplied for the model", async () => {
    const provider = createClaudeCode({
      models: [
        {
          kind: "language",
          providerId: "claude-code",
          modelId: "sonnet",
          contextWindow: 200_000,
          capabilities: { localTools: true },
        },
      ],
    })

    const resolved = await provider("sonnet").resolve?.({ offline: true })
    expect(resolved?.definition.contextWindow).toBe(200_000)
  })
})

describe("environment", () => {
  // Guard proof: return `inherited` unchanged; the API keys and the host session's variables then
  // reach Claude Code.
  test("keeps the project's API keys and a surrounding Claude Code session out of Claude Code", () => {
    const env = environment({
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      ANTHROPIC_API_KEY: "key",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "host-session",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/socket",
      CLAUDE_CODE_MESSAGING_TOKEN: "secret",
      CLAUDE_EFFORT: "high",
    })

    expect(env).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_AGENT_SDK_CLIENT_APP: "sixb",
    })
  })
})

describe("modelInfoDefinition", () => {
  test("describes a listed model with the efforts Claude Code offers for it", () => {
    const definition = modelInfoDefinition({
      value: "haiku",
      displayName: "Haiku 5.5",
      description: "Fastest for quick answers",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    })

    expect(definition).toMatchObject({
      providerId: "claude-code",
      modelId: "haiku",
      name: "Haiku 5.5",
      description: "Fastest for quick answers",
      publisher: { id: "anthropic", name: "Anthropic" },
      capabilities: {
        reasoning: { canDisable: false, efforts: ["low", "medium", "high", "xhigh", "max"] },
      },
    })
  })

  test("leaves reasoning unknown when Claude Code says nothing about it", () => {
    const definition = modelInfoDefinition({
      value: "claude-old",
      displayName: "Old",
      description: "",
    })

    expect(definition.capabilities.reasoning).toBeUndefined()
    expect(definition.description).toBeUndefined()
  })
})

describe("reasoningOptions", () => {
  test("maps Sixb's reasoning onto Claude Code's effort and thinking", () => {
    expect(reasoningOptions(undefined)).toEqual({})
    expect(reasoningOptions("provider-default")).toEqual({})
    expect(reasoningOptions("none")).toEqual({ thinking: { type: "disabled" } })
    expect(reasoningOptions("minimal")).toEqual({ effort: "low" })
    expect(reasoningOptions("xhigh")).toEqual({ effort: "xhigh" })
    expect(reasoningOptions({ budgetTokens: 2_048 })).toEqual({
      thinking: { type: "enabled", budgetTokens: 2_048 },
    })
  })
})
