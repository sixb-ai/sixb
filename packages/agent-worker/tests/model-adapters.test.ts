import { describe, expect, test } from "bun:test"
import {
  AgentToolPublicError,
  type AgentToolRunContext,
  defineAgentTool,
  defineConnector,
  noopLogger,
  stringEnum,
} from "@sixb/core"
import { runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import type { ModelAssistantPart, ModelStep, ModelUsage, ProviderData } from "@sixb/core/models"
import {
  agentToolErrorText,
  agentTraceFromModelSteps,
  agentTraceFromPartialModelLoop,
  aiModelCallUsageFromModel,
  modelToolsFromAgentDefinitions,
} from "../src/model-adapters"
import { WorkerTestModel } from "./worker-model-fixture"

const connector = (() => Promise.reject(new Error("unused"))) as AgentToolRunContext["connector"]
const toolRuntime = {
  artifactsForToolCall() {
    return {
      async put() {
        throw new Error("unused")
      },
    }
  },
  toolResultToModelOutput() {
    return { type: "text" as const, value: "unused" }
  },
}

function modelStep(content: readonly ModelAssistantPart[]): ModelStep {
  return {
    responseId: "response-1",
    finishReason: "stop",
    usage: {},
    cost: { status: "unpriceable", reason: "missing-rate-card" },
    content,
  }
}

describe("owned model adapters", () => {
  // Regression proof: return response.content as partialContent after pushing the completed step.
  test("retains a tool outcome exactly once when execution races with cancellation", async () => {
    const abort = new AbortController()
    const model = new WorkerTestModel()
    model.stream = async () => ({
      events: (async function* () {
        yield { type: "stream-start" } as const
        yield { type: "tool-call", toolCallId: "tool-1", toolName: "save", input: "{}" } as const
        yield { type: "finish", finishReason: "tool-calls", usage: {} } as const
      })(),
    })
    const result = await runModelLoop({
      model,
      messages: [],
      tools: [
        {
          name: "save",
          description: "Save",
          inputSchema: { type: "object" },
          parseInput: (value) => value,
          async execute() {
            abort.abort()
            return "saved"
          },
          errorText: () => "failed",
        },
      ],
      maxSteps: 2,
      signal: abort.signal,
    })
    expect(result.status).toBe("aborted")
    if (result.status !== "aborted") throw new Error("Expected cancellation")
    expect(agentTraceFromPartialModelLoop(result.steps, result.partialContent)).toEqual([
      { type: "step-start" },
      {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "save",
        input: {},
        state: "output-available",
        output: "saved",
      },
    ])
  })

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
        run,
      }))
    const run = { kind: "conversation" as const, id: "run-1", threadId: "thread-1" }
    const [tool] = modelToolsFromAgentDefinitions({
      definitions: [definition],
      valueTypesById: new Map(),
      run,
      connector: resolve,
      logger: noopLogger,
      ...toolRuntime,
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
      tool?.execute(parsed, {
        signal: new AbortController().signal,
        callId: "call-1",
        toolCallId: "tool-call-1",
      })
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
        run: { kind: "conversation", id: "run-2", threadId: "thread" },
        connector,
        logger: noopLogger,
        ...toolRuntime,
      })
    ).toThrow("duplicate selected tool name 'echo'")

    const [tool] = modelToolsFromAgentDefinitions({
      definitions: [definition],
      valueTypesById: new Map(),
      run: { kind: "conversation", id: "run-2", threadId: "thread" },
      connector,
      logger: noopLogger,
      ...toolRuntime,
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
      run: { kind: "conversation", id: "run-3", threadId: "thread" },
      connector,
      logger: noopLogger,
      ...toolRuntime,
    })
    await expect(
      tool?.execute(
        {},
        {
          signal: new AbortController().signal,
          callId: "call-2",
          toolCallId: "tool-call-2",
        }
      )
    ).rejects.toBe(safe)
  })

  test("converts model steps into durable text, replay state, and folded tool outcomes", () => {
    const steps: ModelStep[] = [
      {
        responseId: "response-1",
        finishReason: "tool-calls",
        usage: {},
        cost: { status: "unpriceable", reason: "missing-rate-card" },
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
        cost: { status: "unpriceable", reason: "missing-rate-card" },
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

  test("preserves normalized metadata, signed replay state, and original tool output", () => {
    // Regression proof: drop originalOutput or providerData from trace projection.
    const normalized = { anthropic: { signature: "signed", caller: { toolName: "search" } } }
    const providerData: ProviderData = normalized
    const content: ModelAssistantPart[] = [
      { type: "reasoning", text: "think", providerData },
      { type: "text", text: "searching", providerData },
      { type: "provider-state", providerId: "anthropic", data: { id: "opaque" } },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "tool-search",
        input: {},
        dynamic: true,
        providerExecuted: true,
        providerData,
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "tool-search",
        output: { type: "text", value: "projected for model" },
        originalOutput: { hits: 2 },
      },
    ]
    const trace = agentTraceFromModelSteps([modelStep(content)])
    expect(trace).toStrictEqual([
      { type: "step-start" },
      { type: "reasoning", text: "think", providerMetadata: normalized },
      { type: "text", text: "searching", providerMetadata: normalized },
      { type: "provider-state", providerId: "anthropic", data: { id: "opaque" } },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "tool-search",
        input: {},
        dynamic: true,
        providerExecuted: true,
        providerMetadata: normalized,
        state: "output-available",
        output: { hits: 2 },
      },
    ])
    expect(toModelMessages([{ role: "assistant", parts: trace }])).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "think", providerData: normalized },
          { type: "text", text: "searching", providerData: normalized },
          content[2],
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "tool-search",
            input: {},
            providerExecuted: true,
            providerData: normalized,
          },
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "tool-search",
            output: { type: "json", value: { hits: 2 } },
          },
        ],
      },
    ])
  })

  test("preserves terminal tool errors and distinguishes missing results from cancellation", () => {
    // Regression proof: use the completed-step fallback for partial content; cancellation changes.
    const call = {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "search",
      input: null,
    } as const
    const step = modelStep([
      call,
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "search",
        output: { type: "error-json", value: { error: "unavailable" } },
      },
    ])
    expect(agentTraceFromPartialModelLoop([step], [call])).toEqual([
      { type: "step-start" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "search",
        input: null,
        state: "output-error",
        errorText: '{"error":"unavailable"}',
      },
      { type: "step-start" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "search",
        input: null,
        state: "output-error",
        errorText: "Tool execution was cancelled.",
      },
    ])
    expect(agentTraceFromModelSteps([modelStep([call])])[1]).toMatchObject({
      state: "output-error",
      errorText: "Tool call did not produce a result.",
    })
    expect(agentTraceFromPartialModelLoop([step], [])).toEqual(agentTraceFromModelSteps([step]))
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
