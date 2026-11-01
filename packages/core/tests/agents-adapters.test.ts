import { describe, expect, test } from "bun:test"
import type { AgentMessage, AgentMessagePart, AgentMessageRole, FileRef } from "../src"
import { agentMessageSteps, toModelMessages } from "../src/agents"

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

describe("toModelMessages", () => {
  test("projects context once before the user text", () => {
    expect(
      toModelMessages([
        sixbMessage("user", [
          { type: "text", text: "What should I do next?" },
          {
            type: "context",
            context: {
              kind: "object",
              ref: { objectTypeId: "Invoice", primaryId: "inv-123" },
            },
            origin: "ambient",
          },
        ]),
      ])
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "<sixb_user_context>",
              "  <object_context>",
              "    <object_type_id>Invoice</object_type_id>",
              "    <primary_id>inv-123</primary_id>",
              "  </object_context>",
              "</sixb_user_context>",
              "",
              "",
            ].join("\n"),
          },
          { type: "text", text: "What should I do next?" },
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

  // Regression check: restore the assistant fileText branch in adapters.ts; this must fail.
  test("keeps attachment metadata out of assistant-authored history", () => {
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
        content: [{ type: "text", text: "I created the report." }],
      },
    ])
  })

  // Regression check: remove the empty-content guard in adapters.ts; this must fail.
  test("omits file-only assistant blocks while preserving adjacent text", () => {
    expect(
      toModelMessages([
        sixbMessage("assistant", [{ type: "file", fileRef }]),
        sixbMessage("assistant", [
          { type: "file", fileRef },
          { type: "step-start" },
          { type: "text", text: "Done." },
          { type: "step-start" },
          { type: "file", fileRef },
        ]),
      ])
    ).toEqual([{ role: "assistant", content: [{ type: "text", text: "Done." }] }])
  })

  test("joins system text into one string and merges its providerMetadata into providerData", () => {
    expect(
      toModelMessages([
        sixbMessage("system", [
          { type: "text", text: "You are " },
          {
            type: "text",
            text: "helpful.",
            providerMetadata: { anthropic: { cacheControl: "ephemeral" } },
          },
        ]),
      ])
    ).toEqual([
      {
        role: "system",
        content: "You are helpful.",
        providerData: { anthropic: { cacheControl: "ephemeral" } },
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

  test("reconstructs rich tool-result files with caller-provided replay projections", () => {
    const imageRef = { ...fileRef, mediaType: "image/png", fileName: "generated.png" }
    const message: AgentMessage & { readonly id: string } = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          toolCallId: "image-call-1",
          toolName: "create_image",
          input: {},
          state: "output-available",
          output: {
            kind: "agentToolResult",
            content: [
              { type: "text", text: "Created the image." },
              { type: "file", fileRef: imageRef },
            ],
          },
        },
      ],
    }
    const result = toModelMessages([message], {
      toolResultFileText: ({ message, partIndex, contentIndex }) =>
        message.id === "assistant-1" && partIndex === 0 && contentIndex === 1
          ? "Current tool file metadata"
          : undefined,
    })

    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "image-call-1",
            toolName: "create_image",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "image-call-1",
            toolName: "create_image",
            output: {
              type: "text",
              value: "Created the image.\nCurrent tool file metadata",
            },
          },
        ],
      },
    ])
  })

  // Removal proof: drop the storedModelOutput branch in toolResultOutput; the call replays its
  // durable output, a JSON object and file metadata, instead of the text the model read.
  test("replays the model output a call stored, not a new projection of its output", () => {
    const call = (modelOutput: unknown) =>
      ({
        type: "tool-call",
        toolCallId: "publish",
        toolName: "publish_artifact",
        input: {},
        state: "output-available",
        output: {
          kind: "agentToolResult",
          content: [
            { type: "text", text: "Published." },
            { type: "file", fileRef },
          ],
        },
        modelOutput,
      }) as AgentMessagePart
    const replayed = (modelOutput: unknown) =>
      toModelMessages([sixbMessage("assistant", [call(modelOutput)])], {
        toolResultFileText: () => "<attachment />",
      })[1]

    expect(replayed({ type: "text", value: 'Published "Plan" as artifact art_1.' })).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "publish",
          toolName: "publish_artifact",
          output: { type: "text", value: 'Published "Plan" as artifact art_1.' },
        },
      ],
    })
    expect(replayed({ type: "json", value: { b: 1, a: 2 } })).toMatchObject({
      content: [{ output: { type: "json", value: { b: 1, a: 2 } } }],
    })

    // A shape the loop would not have sent is ignored: the call projects its output as before.
    for (const invalid of [
      undefined,
      null,
      { type: "text", value: 1 },
      { type: "error-text", value: "x" },
    ]) {
      expect(replayed(invalid)).toMatchObject({
        content: [{ output: { type: "text", value: "Published.\n<attachment />" } }],
      })
    }
  })

  // Removal proofs: keep a provider-executed call in localToolCalls, and the step's tool message
  // is named by a call it does not replay; keep empty steps, and a step-start pair yields one.
  test("splits a stored message into steps and names each by its first local call", () => {
    const call = (toolCallId: string, providerExecuted?: true): AgentMessagePart => ({
      type: "tool-call",
      toolCallId,
      toolName: "search",
      input: {},
      ...(providerExecuted ? { providerExecuted } : {}),
      state: "output-available",
      output: "found",
    })
    const steps = agentMessageSteps({
      parts: [
        { type: "step-start" },
        { type: "step-start" },
        call("web", true),
        call("local"),
        { type: "step-start" },
        { type: "text", text: "Done." },
      ],
    })

    expect(steps.map((step) => step.parts.map(({ partIndex }) => partIndex))).toEqual([[2, 3], [5]])
    expect(steps.map((step) => step.localToolCalls.map(({ partIndex }) => partIndex))).toEqual([
      [3],
      [],
    ])
  })

  // Removal proof: drop the afterToolResults call in appendAssistantModelMessages; the replayed
  // step loses the message that followed its results.
  test("replays what followed a step's tool results right after them", () => {
    const call = (toolCallId: string): AgentMessagePart => ({
      type: "tool-call",
      toolCallId,
      toolName: "view_file",
      input: {},
      state: "output-available",
      output: "viewed",
    })
    const asked: number[] = []
    const result = toModelMessages(
      [
        sixbMessage("assistant", [
          { type: "step-start" },
          { type: "text", text: "Looking." },
          call("a"),
          call("b"),
          { type: "step-start" },
          { type: "text", text: "Done." },
        ]),
      ],
      {
        afterToolResults: ({ partIndex }) => {
          asked.push(partIndex)
          return { role: "user", content: [{ type: "text", text: `files after ${partIndex}` }] }
        },
      }
    )

    expect(asked).toEqual([2])
    expect(result.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "assistant",
    ])
    expect(result[2]).toEqual({ role: "user", content: [{ type: "text", text: "files after 2" }] })
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
