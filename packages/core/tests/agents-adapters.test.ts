import { describe, expect, test } from "bun:test"
import {
  type AgentInboundUiMessage,
  type AgentMessage,
  AgentMessageAdapterError,
  type AgentMessagePart,
  type AgentMessageRole,
  fromAiSdk,
  toModelMessages,
  toUiMessage,
} from "../src"

function sixbMessage(role: AgentMessageRole, parts: AgentMessagePart[]): AgentMessage {
  return { role, parts }
}

describe("fromAiSdk", () => {
  test("maps text, reasoning, and step-start parts", () => {
    const message: AgentInboundUiMessage = {
      role: "assistant",
      metadata: { traceId: "t1" },
      parts: [
        { type: "step-start" },
        {
          type: "reasoning",
          text: "let me think",
          providerMetadata: { anthropic: { signature: "sig" } },
        },
        { type: "text", text: "hello", state: "done" },
      ],
    }
    expect(fromAiSdk(message)).toEqual({
      role: "assistant",
      metadata: { traceId: "t1" },
      parts: [
        { type: "step-start" },
        {
          type: "reasoning",
          text: "let me think",
          providerMetadata: { anthropic: { signature: "sig" } },
        },
        { type: "text", text: "hello" },
      ],
    })
  })

  test("normalizes static and dynamic tool calls into a single tool-call part", () => {
    const message: AgentInboundUiMessage = {
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "call_1",
          state: "output-available",
          input: { cmd: "ls" },
          output: "file.txt",
          providerExecuted: false,
        },
        {
          type: "dynamic-tool",
          toolName: "search",
          toolCallId: "call_2",
          state: "output-error",
          input: { q: "x" },
          errorText: "rate limited",
        },
      ],
    }
    expect(fromAiSdk(message).parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "bash",
        input: { cmd: "ls" },
        providerExecuted: false,
        state: "output-available",
        output: "file.txt",
      },
      {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "search",
        dynamic: true,
        input: { q: "x" },
        state: "output-error",
        errorText: "rate limited",
      },
    ])
  })

  test("is total: throws on unmodeled part kinds", () => {
    const message = {
      role: "assistant",
      parts: [{ type: "file", url: "https://x", mediaType: "image/png" }],
    } as unknown as AgentInboundUiMessage
    expect(() => fromAiSdk(message)).toThrow(AgentMessageAdapterError)
  })

  test("throws on transient/streaming states that must never be persisted", () => {
    const streamingText = {
      role: "assistant",
      parts: [{ type: "text", text: "partial", state: "streaming" }],
    } as unknown as AgentInboundUiMessage
    expect(() => fromAiSdk(streamingText)).toThrow(AgentMessageAdapterError)

    const transientTool = {
      role: "assistant",
      parts: [{ type: "tool-bash", toolCallId: "c", state: "input-available", input: {} }],
    } as unknown as AgentInboundUiMessage
    expect(() => fromAiSdk(transientTool)).toThrow(AgentMessageAdapterError)

    const approval = {
      role: "assistant",
      parts: [{ type: "tool-bash", toolCallId: "c", state: "approval-requested", input: {} }],
    } as unknown as AgentInboundUiMessage
    expect(() => fromAiSdk(approval)).toThrow(AgentMessageAdapterError)
  })

  test("throws on an unsupported role", () => {
    const message = { role: "tool", parts: [] } as unknown as AgentInboundUiMessage
    expect(() => fromAiSdk(message)).toThrow(AgentMessageAdapterError)
  })

  test("throws on out-of-contract (non-JSON) payloads", () => {
    const message = {
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "c",
          state: "output-available",
          input: { when: new Date() },
          output: "ok",
        },
      ],
    } as unknown as AgentInboundUiMessage
    expect(() => fromAiSdk(message)).toThrow(AgentMessageAdapterError)
  })
})

describe("envelope round-trip (fromAiSdk ∘ toUiMessage)", () => {
  const cases: Record<string, AgentMessage> = {
    text: sixbMessage("user", [{ type: "text", text: "hi" }]),
    "with message metadata": {
      role: "assistant",
      metadata: { traceId: "t1", tokens: 42 },
      parts: [{ type: "text", text: "hi" }],
    },
    "text with provider metadata": sixbMessage("assistant", [
      { type: "text", text: "hi", providerMetadata: { openai: { x: 1 } } },
    ]),
    reasoning: sixbMessage("assistant", [
      { type: "reasoning", text: "think", providerMetadata: { anthropic: { signature: "s" } } },
    ]),
    "step boundaries": sixbMessage("assistant", [
      { type: "step-start" },
      { type: "text", text: "a" },
      { type: "step-start" },
      { type: "text", text: "b" },
    ]),
    "static tool ok": sixbMessage("assistant", [
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "bash",
        input: { cmd: "ls" },
        state: "output-available",
        output: { files: ["a", "b"] },
      },
    ]),
    "dynamic tool error": sixbMessage("assistant", [
      {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "search",
        dynamic: true,
        providerExecuted: true,
        providerMetadata: { anthropic: { cacheControl: "x" } },
        input: { q: "y" },
        state: "output-error",
        errorText: "boom",
      },
    ]),
  }

  for (const [name, original] of Object.entries(cases)) {
    test(`round-trips: ${name}`, () => {
      expect(fromAiSdk(toUiMessage(original))).toEqual(original)
    })
  }
})

describe("toModelMessages", () => {
  test("projects a user message", () => {
    expect(toModelMessages([sixbMessage("user", [{ type: "text", text: "hi" }])])).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ])
  })

  test("joins system text into a single string", () => {
    expect(
      toModelMessages([
        sixbMessage("system", [
          { type: "text", text: "You are " },
          { type: "text", text: "helpful." },
        ]),
      ])
    ).toEqual([{ role: "system", content: "You are helpful." }])
  })

  test("merges system text providerMetadata into providerOptions", () => {
    expect(
      toModelMessages([
        sixbMessage("system", [
          {
            type: "text",
            text: "Cached prompt",
            providerMetadata: { anthropic: { cacheControl: "ephemeral" } },
          },
        ]),
      ])
    ).toEqual([
      {
        role: "system",
        content: "Cached prompt",
        providerOptions: { anthropic: { cacheControl: "ephemeral" } },
      },
    ])
  })

  test("splits an assistant tool call into assistant + tool messages", () => {
    const result = toModelMessages([
      sixbMessage("assistant", [
        { type: "reasoning", text: "thinking" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "bash",
          input: { cmd: "ls" },
          state: "output-available",
          output: "file.txt",
        },
        { type: "text", text: "done" },
      ]),
    ])
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { cmd: "ls" } },
          { type: "text", text: "done" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "bash",
            output: { type: "text", value: "file.txt" },
          },
        ],
      },
    ])
  })

  test("maps object tool output to json and errors to error-text", () => {
    const json = toModelMessages([
      sixbMessage("assistant", [
        {
          type: "tool-call",
          toolCallId: "c",
          toolName: "bash",
          input: {},
          state: "output-available",
          output: { ok: true },
        },
      ]),
    ])
    expect(json[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c",
          toolName: "bash",
          output: { type: "json", value: { ok: true } },
        },
      ],
    })

    const errored = toModelMessages([
      sixbMessage("assistant", [
        {
          type: "tool-call",
          toolCallId: "c",
          toolName: "bash",
          input: {},
          state: "output-error",
          errorText: "nope",
        },
      ]),
    ])
    expect(errored[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c",
          toolName: "bash",
          output: { type: "error-text", value: "nope" },
        },
      ],
    })
  })

  test("keeps provider-executed tool results inline in the assistant message", () => {
    const result = toModelMessages([
      sixbMessage("assistant", [
        {
          type: "tool-call",
          toolCallId: "c",
          toolName: "web_search",
          providerExecuted: true,
          input: { q: "x" },
          state: "output-available",
          output: { hits: 3 },
        },
      ]),
    ])
    // One assistant message containing both the call and its result; no separate tool message.
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c",
          toolName: "web_search",
          input: { q: "x" },
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "c",
          toolName: "web_search",
          output: { type: "json", value: { hits: 3 } },
        },
      ],
    })
  })

  test("opens a new assistant message at each step boundary", () => {
    const result = toModelMessages([
      sixbMessage("assistant", [
        { type: "step-start" },
        { type: "text", text: "step one" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          input: {},
          state: "output-available",
          output: "ok",
        },
        { type: "step-start" },
        { type: "text", text: "step two" },
      ]),
    ])
    expect(result.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"])
    expect(result[0]).toMatchObject({ role: "assistant" })
    expect(result[2]).toEqual({ role: "assistant", content: [{ type: "text", text: "step two" }] })
  })
})
