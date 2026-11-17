import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { type LanguageModelStreamEvent, ModelProviderError } from "@sixb/core/models"
import { ClaudeCodeStream } from "../src/stream"

/** Fixtures carry only the fields the stream reads. */
function sdk(message: object): SDKMessage {
  return { parent_tool_use_id: null, session_id: "session-1", ...message } as SDKMessage
}

function event(value: object): SDKMessage {
  return sdk({ type: "stream_event", uuid: crypto.randomUUID(), event: value })
}

function messageStart(id: string, usage: object): SDKMessage {
  return event({ type: "message_start", message: { id, model: "claude-haiku-5-5", usage } })
}

function messageEnd(stopReason: string, usage: object): SDKMessage[] {
  return [
    event({ type: "message_delta", delta: { stop_reason: stopReason }, usage }),
    event({ type: "message_stop" }),
  ]
}

function run(stream: ClaudeCodeStream, messages: readonly SDKMessage[]) {
  return messages.flatMap((message) => stream.accept(message))
}

describe("ClaudeCodeStream", () => {
  test("streams text and Sixb's tool calls, then ends at the session entry to resume", () => {
    const stream = new ClaudeCodeStream({ modelId: "haiku", structuredOutput: false })
    const events = run(stream, [
      messageStart("msg_1", { input_tokens: 10, cache_read_input_tokens: 100 }),
      event({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
      event({ type: "content_block_stop", index: 0 }),
      sdk({ type: "assistant", uuid: "entry-1", message: { content: [] } }),
      event({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "mcp__sixb__lookup" },
      }),
      event({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"item":"7"}' },
      }),
      sdk({ type: "assistant", uuid: "entry-2", message: { content: [] } }),
      event({ type: "content_block_stop", index: 1 }),
      event({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_2", name: "mcp__sixb__clock" },
      }),
      sdk({ type: "assistant", uuid: "entry-3", message: { content: [] } }),
      event({ type: "content_block_stop", index: 2 }),
      ...messageEnd("tool_use", { output_tokens: 20 }),
    ])

    expect(stream.toolCallsReady).toBe(true)
    expect<unknown[]>([...events, ...stream.finish()]).toEqual([
      {
        type: "response-metadata",
        id: "msg_1",
        providerIds: { responseId: "msg_1" },
        modelId: "claude-haiku-5-5",
      },
      { type: "text-start", id: "msg_1:0" },
      { type: "text-delta", id: "msg_1:0", delta: "Hi" },
      { type: "text-end", id: "msg_1:0" },
      { type: "tool-input-start", id: "toolu_1", toolName: "lookup" },
      { type: "tool-input-delta", id: "toolu_1", delta: '{"item":"7"}' },
      { type: "tool-input-end", id: "toolu_1" },
      { type: "tool-input-start", id: "toolu_2", toolName: "clock" },
      { type: "tool-input-delta", id: "toolu_2", delta: "{}" },
      {
        type: "tool-input-end",
        id: "toolu_2",
        providerData: { "claude-code": { sessionId: "session-1", at: "entry-3" } },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        rawFinishReason: "tool_use",
        usage: expect.objectContaining({
          inputTokens: 110,
          cacheReadInputTokens: 100,
          outputTokens: 20,
        }),
      },
    ])
  })

  test("keeps Claude Code's own tool calls inside it, and answers with the structured output", () => {
    const stream = new ClaudeCodeStream({ modelId: "haiku", structuredOutput: true })
    const events = run(stream, [
      messageStart("msg_1", { input_tokens: 10 }),
      event({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      event({ type: "content_block_stop", index: 0 }),
      event({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "StructuredOutput" },
      }),
      sdk({ type: "assistant", uuid: "entry-1", message: { content: [] } }),
      event({ type: "content_block_stop", index: 1 }),
      sdk({ type: "user", uuid: "entry-2", message: { role: "user", content: [] } }),
      ...messageEnd("tool_use", { output_tokens: 5 }),
      sdk({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: { capital: "Paris" },
      }),
    ])

    expect(stream.toolCallsReady).toBe(false)
    expect(stream.done).toBe(true)
    const answer = [...events, ...stream.finish()].filter(
      (value: LanguageModelStreamEvent) => value.type !== "response-metadata"
    )
    expect(answer).toEqual([
      { type: "text-start", id: "structured-output" },
      { type: "text-delta", id: "structured-output", delta: '{"capital":"Paris"}' },
      {
        type: "text-end",
        id: "structured-output",
        providerData: { "claude-code": { sessionId: "session-1", at: "entry-2" } },
      },
      expect.objectContaining({ type: "finish", finishReason: "stop" }),
    ])
  })

  test("adds up the usage of every API call in the query", () => {
    const stream = new ClaudeCodeStream({ modelId: "haiku", structuredOutput: false })
    run(stream, [
      messageStart("msg_1", { input_tokens: 10 }),
      ...messageEnd("tool_use", { output_tokens: 5 }),
      messageStart("msg_2", { input_tokens: 3, cache_read_input_tokens: 40 }),
      ...messageEnd("end_turn", { output_tokens: 7 }),
      sdk({ type: "result", subtype: "success", is_error: false, result: "" }),
    ])

    expect(stream.finish().at(-1)).toMatchObject({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 53, outputTokens: 12, cacheReadInputTokens: 40 },
    })
  })

  test("reports a failed turn with Claude Code's reason", () => {
    const stream = new ClaudeCodeStream({ modelId: "haiku", structuredOutput: false })
    const failed = sdk({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["No conversation found with session ID: session-1"],
    })

    expect(() => stream.accept(failed)).toThrow(
      new ModelProviderError(
        "[SixbClaudeCode] Claude Code failed: No conversation found with session ID: session-1",
        "claude-code",
        "haiku"
      )
    )
  })

  test("tells a signed-out user how to sign in", () => {
    const stream = new ClaudeCodeStream({ modelId: "haiku", structuredOutput: false })
    const signedOut = sdk({
      type: "assistant",
      uuid: "entry-1",
      error: "authentication_failed",
      message: { content: [{ type: "text", text: "Invalid API key" }] },
    })

    const error = (() => {
      try {
        stream.accept(signedOut)
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(ModelProviderError)
    expect(error).toMatchObject({
      message:
        "[SixbClaudeCode] Claude Code is not signed in here: on a computer, run `claude` and sign in with /login; on a server, set CLAUDE_CODE_OAUTH_TOKEN to a token from `claude setup-token`.",
      code: "authentication_failed",
      retryable: false,
    })
  })
})
