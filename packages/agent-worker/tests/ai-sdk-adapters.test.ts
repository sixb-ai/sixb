import { describe, expect, test } from "bun:test"
import {
  type AgentToolRunContext,
  defineAgentTool,
  defineConnector,
  type JsonValue,
  type Logger,
  noopLogger,
  stringEnum,
} from "@sixb/core"
import type { LanguageModelUsage, ToolSet } from "ai"
import {
  agentRunUsageFromAiSdk,
  agentTraceFromAiSdkSteps,
  aiSdkToolsFromAgentDefinitions,
} from "../src/ai-sdk-adapters"

describe("AI SDK agent adapters", () => {
  test("converts Sixb tool definitions and supplies the narrow run-scoped context", async () => {
    const connectorDefinition = defineConnector("knowledge", {
      type: "knowledge",
      connect() {
        return { search: (query: string) => [`found:${query}`] }
      },
    })
    const client = await connectorDefinition.adapter.connect()
    let resolvedDefinition: unknown
    const connector = (async (definition: unknown) => {
      resolvedDefinition = definition
      return client
    }) as AgentToolRunContext["connector"]
    const logEntries: Array<{ readonly message: string; readonly fields?: object }> = []
    const logger = recordingLogger(logEntries)
    const definition = defineAgentTool("search_knowledge")
      .description("Search project knowledge.")
      .input({
        query: "string",
        limit: "integer",
        mode: stringEnum(["quick", "deep"]),
      })
      .run(async ({ input, signal, run, connector: resolve, logger: runLogger }) => {
        const knowledge = await resolve(connectorDefinition)
        runLogger.info("searching", { query: input.query })
        return {
          results: knowledge.search(input.query),
          limit: input.limit,
          mode: input.mode,
          aborted: signal.aborted,
          run: { id: run.id, agentId: run.agentId, threadId: run.threadId ?? null },
        }
      })
    const run = { id: "run-1", agentId: "research", threadId: "thread-1" }
    const tools = aiSdkToolsFromAgentDefinitions({
      definitions: [definition],
      valueTypesById: new Map(),
      run: { id: run.id, agentId: run.agentId, threadId: run.threadId },
      connector,
      logger,
    })
    const adapted = executableTool(tools, definition.name)
    const schema = await toolJsonSchema(adapted)

    expect(schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        mode: { enum: ["quick", "deep"] },
      },
      required: ["query", "limit", "mode"],
      additionalProperties: false,
    })

    const abort = new AbortController()
    await expect(
      adapted.execute({ query: "sixb", limit: 2, mode: "quick" }, { abortSignal: abort.signal })
    ).resolves.toEqual({
      results: ["found:sixb"],
      limit: 2,
      mode: "quick",
      aborted: false,
      run,
    })
    expect(resolvedDefinition).toBe(connectorDefinition)
    expect(logEntries).toEqual([{ message: "searching", fields: { query: "sixb" } }])
  })

  test("passes cancellation to an executing Sixb tool definition", async () => {
    let receivedSignal: AbortSignal | undefined
    const started = Promise.withResolvers<void>()
    const definition = defineAgentTool("wait")
      .description("Wait until cancelled.")
      .input({})
      .run(async ({ signal }) => {
        receivedSignal = signal
        started.resolve()
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))
        return { cancelled: signal.aborted }
      })
    const tools = aiSdkToolsFromAgentDefinitions({
      definitions: [definition],
      valueTypesById: new Map(),
      run: { id: "run-2", agentId: "waiter" },
      connector: (() => Promise.reject(new Error("unused"))) as AgentToolRunContext["connector"],
      logger: noopLogger,
    })
    const abort = new AbortController()
    const execution = executableTool(tools, definition.name).execute(
      {},
      { abortSignal: abort.signal }
    )

    await started.promise
    abort.abort()

    await expect(execution).resolves.toEqual({ cancelled: true })
    expect(receivedSignal).toBe(abort.signal)
  })

  test("rejects a non-JSON Sixb tool result at the AI SDK boundary", async () => {
    const definition = defineAgentTool("invalid_result")
      .description("Return an invalid result.")
      .input({})
      .run((() => ({ value: undefined })) as never)
    const tools = aiSdkToolsFromAgentDefinitions({
      definitions: [definition],
      valueTypesById: new Map(),
      run: { id: "run-3", agentId: "broken" },
      connector: (() => Promise.reject(new Error("unused"))) as AgentToolRunContext["connector"],
      logger: noopLogger,
    })

    await expect(executableTool(tools, definition.name).execute({}, {})).rejects.toThrow(
      "[SixbAgentWorker] Agent tool 'invalid_result' returned a non-JSON result; result.value is undefined."
    )
  })

  test("keeps prototype-like valid tool names as own properties", () => {
    const definition = defineAgentTool("__proto__")
      .description("Return a safe result.")
      .input({})
      .run(() => null)
    const tools = aiSdkToolsFromAgentDefinitions({
      definitions: [definition],
      valueTypesById: new Map(),
      run: { id: "run-4", agentId: "prototype" },
      connector: (() => Promise.reject(new Error("unused"))) as AgentToolRunContext["connector"],
      logger: noopLogger,
    })

    expect(Object.hasOwn(tools, definition.name)).toBe(true)
    expect(typeof tools[definition.name]?.execute).toBe("function")
  })

  test("converts ordered step content into the durable Sixb trace", () => {
    const trace = agentTraceFromAiSdkSteps([
      {
        content: [
          { type: "reasoning", text: "I should search." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: { query: "active projects" },
          },
          {
            type: "tool-result",
            toolCallId: "call-1",
            output: { projects: ["project-1"] },
          },
          { type: "text", text: "Found it." },
        ],
      },
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "lookup",
            input: { id: "missing" },
            dynamic: true,
          },
          {
            type: "tool-error",
            toolCallId: "call-2",
            error: new Error("Not found"),
          },
        ],
      },
    ])

    expect(trace).toEqual([
      { type: "step-start" },
      { type: "reasoning", text: "I should search." },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "search",
        input: { query: "active projects" },
        state: "output-available",
        output: { projects: ["project-1"] },
      },
      { type: "text", text: "Found it." },
      { type: "step-start" },
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "lookup",
        input: { id: "missing" },
        dynamic: true,
        state: "output-error",
        errorText: "Not found",
      },
    ])
  })

  test("rejects unsupported or non-JSON trace content instead of silently losing fidelity", () => {
    expect(() => agentTraceFromAiSdkSteps([{ content: [{ type: "source" }] }])).toThrow(
      "trace content 'source' is not supported"
    )

    expect(() =>
      agentTraceFromAiSdkSteps([
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "search",
              input: {},
            },
            { type: "tool-result", toolCallId: "call-1", output: 1n },
          ],
        },
      ])
    ).toThrow("tool output must be a JSON value")
  })

  test("maps AI SDK usage once into the provider-independent storage contract", () => {
    expect(
      agentRunUsageFromAiSdk(
        usage({
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          cachedInputTokens: 3,
          reasoningTokens: 2,
        })
      )
    ).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cachedInputTokens: 3,
      reasoningTokens: 2,
    })

    expect(agentRunUsageFromAiSdk(usage({}))).toBeUndefined()
  })
})

function executableTool(
  tools: ToolSet,
  name: string
): {
  readonly inputSchema: unknown
  execute(
    input: Record<string, unknown>,
    options: { readonly abortSignal?: AbortSignal }
  ): Promise<JsonValue>
} {
  const adapted = tools[name]
  if (!adapted || typeof adapted.execute !== "function") {
    throw new Error(`Expected executable tool '${name}'.`)
  }
  return adapted as never
}

async function toolJsonSchema(toolDefinition: { readonly inputSchema: unknown }): Promise<unknown> {
  const schema = toolDefinition.inputSchema as { readonly jsonSchema: unknown }
  return Promise.resolve(schema.jsonSchema)
}

function recordingLogger(
  entries: Array<{ readonly message: string; readonly fields?: object }>,
  bindings: Readonly<Record<string, JsonValue>> = {}
): Logger {
  const write = (message: string, fields?: Readonly<Record<string, JsonValue>>): void => {
    entries.push({ message, fields: { ...bindings, ...fields } })
  }
  return {
    debug: write,
    info: write,
    warn: write,
    error(message, fields) {
      write(message instanceof Error ? message.message : message, fields)
    },
    child(childBindings) {
      return recordingLogger(entries, { ...bindings, ...childBindings })
    },
  }
}

function usage(input: {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cachedInputTokens?: number
  readonly reasoningTokens?: number
}): LanguageModelUsage {
  return {
    inputTokens: input.inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: input.cachedInputTokens,
      cacheWriteTokens: undefined,
    },
    outputTokens: input.outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: input.reasoningTokens,
    },
    totalTokens: input.totalTokens,
  }
}
