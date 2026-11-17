import { describe, expect, test } from "bun:test"
import { claudeCode, createClaudeCode } from "../src"
import { modelInfoDefinition, reasoningOptions } from "../src/provider"

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
