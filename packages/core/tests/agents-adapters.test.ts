import { describe, expect, test } from "bun:test"
import type {
  AgentInboundUiMessage,
  AgentMessage,
  AgentMessagePart,
  AgentMessageRole,
  FileRef,
} from "../src"
import { AgentMessageAdapterError, fromAiSdk, toModelMessages, toUiMessage } from "../src/agents"

function sixbMessage(role: AgentMessageRole, parts: AgentMessagePart[]): AgentMessage {
  return { role, parts }
}

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 12,
  fileName: "invoice.pdf",
  mediaType: "application/pdf",
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

  test("strips undefined provider metadata object fields", () => {
    const message = {
      role: "assistant",
      metadata: { traceId: "t1", omitted: undefined },
      parts: [
        {
          type: "tool-bash",
          toolCallId: "call_1",
          state: "output-available",
          input: { cmd: "ls" },
          output: "file.txt",
          callProviderMetadata: {
            anthropic: { caller: { toolId: undefined, toolName: "bash" } },
          },
        },
      ],
    } as unknown as AgentInboundUiMessage

    expect(fromAiSdk(message)).toEqual({
      role: "assistant",
      metadata: { traceId: "t1" },
      parts: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "bash",
          input: { cmd: "ls" },
          state: "output-available",
          output: "file.txt",
          providerMetadata: {
            anthropic: { caller: { toolName: "bash" } },
          },
        },
      ],
    })
  })

  test("maps file parts backed by Sixb FileRefs", () => {
    const message: AgentInboundUiMessage = {
      role: "user",
      parts: [{ type: "file", fileRef, providerMetadata: { openai: { purpose: "assistants" } } }],
    }
    expect(fromAiSdk(message)).toEqual({
      role: "user",
      parts: [{ type: "file", fileRef, providerMetadata: { openai: { purpose: "assistants" } } }],
    })
  })

  test("is total: throws on unmodeled part kinds", () => {
    const message = {
      role: "assistant",
      parts: [{ type: "source", url: "https://x" }],
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
    "file attachment": sixbMessage("user", [{ type: "file", fileRef }]),
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

  test("projects user file parts with a caller-provided data resolver", () => {
    const url = new URL("https://sixb.example/files/invoice.pdf")
    expect(
      toModelMessages(
        [
          {
            role: "user",
            parts: [{ type: "file", fileRef }],
            id: "msg_1",
          },
        ],
        { fileData: ({ message }) => (message.id === "msg_1" ? url : undefined) }
      )
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: url,
            filename: "invoice.pdf",
            mediaType: "application/pdf",
          },
        ],
      },
    ])
  })

  test("projects user file parts with caller-provided text context before data", () => {
    const url = new URL("data:image/png;base64,aGVsbG8=")
    expect(
      toModelMessages(
        [
          {
            role: "user",
            parts: [{ type: "file", fileRef: { ...fileRef, mediaType: "image/png" } }],
            id: "msg_1",
          },
        ],
        {
          fileText: ({ message }) =>
            message.id === "msg_1" ? "Attached file: invoice.pdf" : undefined,
          fileData: ({ message }) => (message.id === "msg_1" ? url : undefined),
        }
      )
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Attached file: invoice.pdf" },
          {
            type: "file",
            data: url,
            filename: "invoice.pdf",
            mediaType: "image/png",
          },
        ],
      },
    ])
  })

  test("skips user file parts when no file projection resolvers are provided", () => {
    expect(toModelMessages([sixbMessage("user", [{ type: "file", fileRef }])])).toEqual([
      { role: "user", content: [] },
    ])
  })

  test("projects assistant file parts as caller-provided text context", () => {
    expect(
      toModelMessages(
        [
          {
            role: "assistant",
            parts: [
              { type: "text", text: "I created the report." },
              { type: "file", fileRef },
            ],
            id: "msg_1",
          },
        ],
        {
          fileText: ({ message, partIndex }) =>
            message.id === "msg_1" && partIndex === 1 ? "Generated file: invoice.pdf" : undefined,
        }
      )
    ).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I created the report." },
          { type: "text", text: "Generated file: invoice.pdf" },
        ],
      },
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
