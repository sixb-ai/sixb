import { describe, expect, test } from "bun:test"
import {
  AgentToolPublicError,
  type AgentToolRunContext,
  defineAgentTool,
  defineConnector,
  noopLogger,
  stringEnum,
} from "@sixb/core"
import type { ModelStep, ModelUsage } from "@sixb/core/models"
import {
  agentToolErrorText,
  agentTraceFromModelSteps,
  agentTraceFromPartialModelLoop,
  aiModelCallUsageFromModel,
  modelToolsFromAgentDefinitions,
} from "../src/model-adapters"

const connector = (() => Promise.reject(new Error("unused"))) as AgentToolRunContext["connector"]

describe("owned model adapters", () => {
  test("converts Sixb tool definitions and supplies normalized run-scoped input", async () => {
    const connectorDefinition = defineConnector("knowledge", {
      type: "knowledge",
      connect() {
        return { search: (query: string) => [`found:${query}`] }
      },
    })
    const client = await connectorDefinition.adapter.connect()
    const resolve = (async () => client) as AgentToolRunContext["connector"]
    const definition = defineAgentTool("search_knowledge")
      .description("Search project knowledge.")
      .input({ query: "string", limit: "integer", mode: stringEnum(["quick", "deep"]) })
      .run(async ({ input, signal, run, connector: resolveConnector }) => ({
        results: (await resolveConnector(connectorDefinition)).search(input.query),
        limit: input.limit,
        mode: input.mode,
        aborted: signal.aborted,
        run: { id: run.id, agentId: run.agentId, threadId: run.threadId ?? null },
      }))
    const run = { id: "run-1", agentId: "research", threadId: "thread-1" }
    const [tool] = modelToolsFromAgentDefinitions({
      definitions: [definition],
      valueTypesById: new Map(),
      run: { id: run.id, agentId: run.agentId, threadId: run.threadId },
      connector: resolve,
      logger: noopLogger,
    })

    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        mode: { enum: ["quick", "deep"] },
      },
      required: ["query", "limit", "mode"],
      additionalProperties: false,
    })
    const parsed = tool?.parseInput({ query: "sixb", limit: 2, mode: "quick" })
    expect(Object.isFrozen(parsed)).toBe(true)
    await expect(
      tool?.execute(parsed, { signal: new AbortController().signal, callId: "call-1" })
    ).resolves.toEqual({
      results: ["found:sixb"],
      limit: 2,
      mode: "quick",
      aborted: false,
      run,
    })
  })

  test("rejects duplicate names and invalid tool input before execution", () => {
    const definition = defineAgentTool("echo")
      .description("Echo text.")
      .input({ text: "string" })
      .run(({ input }) => input)
    expect(() =>
      modelToolsFromAgentDefinitions({
        definitions: [definition, definition],
        valueTypesById: new Map(),
        run: { id: "run-2", agentId: "agent" },
        connector,
        logger: noopLogger,
      })
    ).toThrow("duplicate selected tool name 'echo'")

    const [tool] = modelToolsFromAgentDefinitions({
      definitions: [definition],
      valueTypesById: new Map(),
      run: { id: "run-2", agentId: "agent" },
      connector,
      logger: noopLogger,
    })
    expect(() => tool?.parseInput({ text: 42 })).toThrow()
  })

  test("keeps public tool errors safe and redacts internal failures", async () => {
    const safe = new AgentToolPublicError("Safe diagnostic")
    expect(agentToolErrorText(safe)).toBe("Safe diagnostic")
    expect(agentToolErrorText(new Error("secret"))).toBe("An error occurred.")

    const definition = defineAgentTool("fail")
      .description("Fail safely.")
      .input({})
      .run(() => {
        throw safe
      })
    const [tool] = modelToolsFromAgentDefinitions({
      definitions: [definition],
      valueTypesById: new Map(),
      run: { id: "run-3", agentId: "agent" },
      connector,
      logger: noopLogger,
    })
    await expect(
      tool?.execute({}, { signal: new AbortController().signal, callId: "call-2" })
    ).rejects.toBe(safe)
  })

  test("converts model steps into durable text, replay state, and folded tool outcomes", () => {
    const steps: ModelStep[] = [
      {
        responseId: "response-1",
        finishReason: "tool-calls",
        usage: {},
        cost: { status: "unpriceable", reason: "missing-pricing" },
        content: [
          { type: "reasoning", text: "think", providerData: { signature: "signed" } },
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "search",
            input: { query: "sixb" },
          },
          {
            type: "tool-result",
            toolCallId: "tool-1",
            toolName: "search",
            output: { type: "json", value: { hits: 2 } },
          },
          { type: "provider-state", providerId: "openresponses", data: { id: "item-1" } },
        ],
      },
      {
        responseId: "response-2",
        finishReason: "stop",
        usage: {},
        cost: { status: "unpriceable", reason: "missing-pricing" },
        content: [{ type: "text", text: "done" }],
      },
    ]

    expect(agentTraceFromModelSteps(steps)).toEqual([
      { type: "step-start" },
      { type: "reasoning", text: "think", providerMetadata: { signature: "signed" } },
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "search",
        input: { query: "sixb" },
        state: "output-available",
        output: { hits: 2 },
      },
      { type: "provider-state", providerId: "openresponses", data: { id: "item-1" } },
      { type: "step-start" },
      { type: "text", text: "done" },
    ])
  })

  test("marks complete tool input in an aborted step as cancelled", () => {
    expect(
      agentTraceFromPartialModelLoop(
        [],
        [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "bash",
            input: { command: "sleep 30" },
          },
        ]
      )
    ).toEqual([
      { type: "step-start" },
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "bash",
        input: { command: "sleep 30" },
        state: "output-error",
        errorText: "Tool execution was cancelled.",
      },
    ])
  })

  test("preserves every available provider-neutral usage count", () => {
    const usage: ModelUsage = {
      inputTokens: 12,
      outputTokens: 8,
      uncachedInputTokens: 9,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 1,
      textOutputTokens: 6,
      reasoningOutputTokens: 2,
    }
    expect(aiModelCallUsageFromModel(usage)).toEqual(usage)
    expect(aiModelCallUsageFromModel({})).toEqual({})
  })
})
