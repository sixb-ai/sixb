import { describe, expect, test } from "bun:test"
import {
  AgentToolPublicError,
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
  agentToolErrorText,
  agentTraceFromAiSdkSteps,
  aiModelCallUsageFromAiSdk,
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

  test("validates, normalizes, and freezes model input before execution", async () => {
    let receivedInput: Readonly<Record<string, unknown>> | undefined
    const definition = defineAgentTool("create_quote")
      .description("Create a normalized quote.")
      .input({
        customer: "string",
        quantity: "integer",
        amount: "decimal",
        details: {
          type: "object",
          properties: {
            tags: {
              required: true,
              schema: { type: "array", items: "string" },
            },
          },
        },
      })
      .run(({ input }) => {
        receivedInput = input
        return { amount: input.amount }
      })
    const adapted = executableTool(
      aiSdkToolsFromAgentDefinitions({
        definitions: [definition],
        valueTypesById: new Map(),
        run: { id: "run-input", agentId: "quotes" },
        connector: (() => Promise.reject(new Error("unused"))) as AgentToolRunContext["connector"],
        logger: noopLogger,
      }),
      definition.name
    )

    expect(await toolJsonSchema(adapted)).toMatchObject({
      properties: {
        amount: { type: "string", pattern: "^[+-]?\\d+(?:\\.\\d+)?$" },
      },
    })

    const invalidInputs = [
      { customer: "Acme", amount: "1.20", details: { tags: ["priority"] } },
      {
        customer: "Acme",
        quantity: "2",
        amount: "1.20",
        details: { tags: ["priority"] },
      },
      {
        customer: "Acme",
        quantity: 2,
        amount: 1.2,
        details: { tags: ["priority"] },
      },
      {
        customer: "Acme",
        quantity: 2,
        amount: "1.20",
        details: { tags: ["priority"], unexpected: true },
      },
      {
        customer: "Acme",
        quantity: 2,
        amount: "1.20",
        details: { tags: ["priority"] },
        unexpected: true,
      },
    ]
    for (const input of invalidInputs) {
      expect(await validateToolInput(adapted, input)).toMatchObject({ success: false })
    }

    const rawInput = {
      customer: "Acme",
      quantity: 2,
      amount: "+001.2300",
      details: { tags: ["priority"] },
    }
    const validation = await validateToolInput(adapted, rawInput)
    if (!validation.success) throw validation.error
    const normalizedInput = validation.value as typeof rawInput

    expect(normalizedInput).toEqual({
      customer: "Acme",
      quantity: 2,
      amount: "1.23",
      details: { tags: ["priority"] },
    })
    expect(Object.isFrozen(normalizedInput)).toBe(true)
    expect(Object.isFrozen(normalizedInput.details)).toBe(true)
    expect(Object.isFrozen(normalizedInput.details.tags)).toBe(true)

    rawInput.details.tags.push("mutated")
    expect(normalizedInput.details.tags).toEqual(["priority"])
    await expect(adapted.execute(normalizedInput, {})).resolves.toEqual({ amount: "1.23" })
    expect(receivedInput).toBe(normalizedInput)
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

  test("masks unmarked project errors without classifying them by message", async () => {
    const projectError = new Error(
      "[Sixb] Agent tool 'project_failure' result must be a JSON value; lookalike"
    )
    const definition = defineAgentTool("project_failure")
      .description("Throw a project error.")
      .input({})
      .run(() => {
        throw projectError
      })
    const adapted = executableTool(
      aiSdkToolsFromAgentDefinitions({
        definitions: [definition],
        valueTypesById: new Map(),
        run: { id: "run-project-error", agentId: "broken" },
        connector: (() => Promise.reject(new Error("unused"))) as AgentToolRunContext["connector"],
        logger: noopLogger,
      }),
      definition.name
    )

    const error = await adapted.execute({}, {}).catch((caught) => caught)

    expect(error.message).toBe("An error occurred.")
    expect(error.cause).toBe(projectError)
    expect(error).not.toBe(projectError)
  })

  test("preserves tool errors explicitly marked as safe", async () => {
    const publicError = new AgentToolPublicError("Safe project diagnostic")
    const definition = defineAgentTool("public_failure")
      .description("Throw a public project error.")
      .input({})
      .run(() => {
        throw publicError
      })
    const adapted = executableTool(
      aiSdkToolsFromAgentDefinitions({
        definitions: [definition],
        valueTypesById: new Map(),
        run: { id: "run-public-error", agentId: "broken" },
        connector: (() => Promise.reject(new Error("unused"))) as AgentToolRunContext["connector"],
        logger: noopLogger,
      }),
      definition.name
    )

    await expect(adapted.execute({}, {})).rejects.toBe(publicError)
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
            error: new AgentToolPublicError("Not found"),
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

  test("exposes only tool errors explicitly marked as safe", () => {
    const safe = new AgentToolPublicError("Safe diagnostic")
    const internal = new Error("credential=secret")

    expect(agentToolErrorText(safe)).toBe("Safe diagnostic")
    expect(agentToolErrorText(internal)).toBe("An error occurred.")
    expect(
      agentTraceFromAiSdkSteps([
        {
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName: "safe", input: {} },
            { type: "tool-error", toolCallId: "call-1", error: safe },
            { type: "tool-call", toolCallId: "call-2", toolName: "internal", input: {} },
            { type: "tool-error", toolCallId: "call-2", error: internal },
          ],
        },
      ])
    ).toMatchObject([
      { type: "step-start" },
      { toolName: "safe", state: "output-error", errorText: "Safe diagnostic" },
      { toolName: "internal", state: "output-error", errorText: "An error occurred." },
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

  test("preserves every provider-neutral model-call usage field", () => {
    expect(
      aiModelCallUsageFromAiSdk({
        inputTokens: 12,
        inputTokenDetails: {
          noCacheTokens: 9,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
        },
        outputTokens: 8,
        outputTokenDetails: {
          textTokens: 6,
          reasoningTokens: 2,
        },
        totalTokens: 20,
        raw: { provider_meter: 4 },
      })
    ).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      uncachedInputTokens: 9,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 1,
      textOutputTokens: 6,
      reasoningOutputTokens: 2,
    })
    expect(aiModelCallUsageFromAiSdk(usage({}))).toEqual({})
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
  const schema = toolDefinition.inputSchema as ToolInputSchema
  return Promise.resolve(schema.jsonSchema)
}

type ToolInputValidationResult =
  | { readonly success: true; readonly value: Record<string, unknown> }
  | { readonly success: false; readonly error: Error }

interface ToolInputSchema {
  readonly jsonSchema: unknown
  readonly validate?: (
    value: unknown
  ) => ToolInputValidationResult | PromiseLike<ToolInputValidationResult>
}

async function validateToolInput(
  toolDefinition: { readonly inputSchema: unknown },
  input: unknown
): Promise<ToolInputValidationResult> {
  const schema = toolDefinition.inputSchema as ToolInputSchema
  if (!schema.validate) {
    throw new Error("Expected the adapted tool input schema to validate values.")
  }
  return schema.validate(input)
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
