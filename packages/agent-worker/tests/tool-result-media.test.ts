import { describe, expect, test } from "bun:test"
import {
  APICallError,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from "@ai-sdk/provider"
import type { BlobStorage, FileRef, JsonValue } from "@sixb/core"
import { InMemoryBlobStorage } from "@sixb/core"
import {
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  tool,
} from "ai"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { AgentToolResultMediaBridge } from "../src/tool-result-media"

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe("agent tool-result media bridge", () => {
  test("keeps tool results text-only and injects one retry-stable image for the next-step model", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await storeImage(blobStorage)
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      sandboxPathForFileRef: () => "/workspace/.sixb/agent/artifacts/generated.png",
      projectFile: async () => ({
        promptText: "projected",
        modelFileData: {
          data: new URL("data:image/png;base64,iVBORw0KGgo="),
          mediaType: "image/png",
          filename: "generated.png",
        },
      }),
    })
    const signal = new AbortController().signal
    const projected = await bridge.toModelOutput({
      output: richImageResult(fileRef),
      signal,
      toolCallId: "image-call-1",
    })

    expect(projected.type).toBe("text")
    expect(JSON.stringify(projected)).not.toContain('"type":"file"')
    expect(JSON.stringify(projected)).toContain("sandboxPath")
    expect(JSON.stringify(projected)).toContain("not embedded in the tool-result message")

    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Create an image." }] },
    ]
    const prepared = await prepareBridge(bridge, imageModel(), messages)
    expect(prepared?.messages).toHaveLength(2)
    expect(prepared?.messages?.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: expect.stringContaining("not a new user request") },
        {
          type: "file",
          data: new URL("data:image/png;base64,iVBORw0KGgo="),
          mediaType: "image/png",
          filename: "generated.png",
        },
      ],
    })

    // The override carries into an AI SDK provider retry or later step; do not append it again.
    await expect(
      prepareBridge(bridge, imageModel(), prepared?.messages ?? messages)
    ).resolves.toBeUndefined()
  })

  test("uses metadata and the sandbox path when the next-step model cannot accept images", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await storeImage(blobStorage)
    let projections = 0
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      sandboxPathForFileRef: () => "/workspace/generated.png",
      projectFile: async () => {
        projections += 1
        throw new Error("An unsupported model must not project image bytes.")
      },
    })
    const projected = await bridge.toModelOutput({
      output: richImageResult(fileRef),
      signal: new AbortController().signal,
      toolCallId: "image-call-2",
    })

    await expect(prepareBridge(bridge, textModel(), [])).resolves.toBeUndefined()
    expect(projections).toBe(0)
    expect(JSON.stringify(projected)).toContain("/workspace/generated.png")
    expect(JSON.stringify(projected)).not.toContain("data:image")
  })

  test("reuses the same synthetic user image when the provider retries the next call", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await storeImage(blobStorage)
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      projectFile: async () => ({
        promptText: "projected",
        modelFileData: {
          data: new URL("data:image/png;base64,iVBORw0KGgo="),
          mediaType: "image/png",
          filename: "generated.png",
        },
      }),
    })
    let toolSignal = new AbortController().signal
    const createImage = tool({
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      execute(_input, { abortSignal }) {
        toolSignal = abortSignal ?? toolSignal
        return richImageResult(fileRef)
      },
      toModelOutput: ({ output, toolCallId }) =>
        bridge.toModelOutput({ output: output as JsonValue, signal: toolSignal, toolCallId }),
    })
    const retryPrompts: string[] = []
    let calls = 0
    const model = new MockLanguageModelV4({
      supportedUrls: { "image/*": [/^data:/] },
      doStream: async (options) => {
        calls += 1
        if (calls === 1) {
          return modelStream([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "retry-image-call",
              toolName: "create_image",
              input: "{}",
            },
            modelFinish("tool-calls"),
          ])
        }
        retryPrompts.push(JSON.stringify(options.prompt))
        if (calls === 2) {
          throw new APICallError({
            message: "retry once",
            url: "https://provider.invalid",
            requestBodyValues: {},
            statusCode: 503,
            responseHeaders: { "retry-after-ms": "0" },
          })
        }
        return modelStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "done" },
          { type: "text-end", id: "answer" },
          modelFinish("stop"),
        ])
      },
    })
    const result = streamText({
      model,
      prompt: "Create an image.",
      tools: { create_image: createImage },
      prepareStep: bridge.prepareStep as never,
      stopWhen: stepCountIs(3),
      maxRetries: 1,
    })

    await expect(result.text).resolves.toBe("done")
    expect(calls).toBe(3)
    expect(retryPrompts).toHaveLength(2)
    expect(retryPrompts[0]).toBe(retryPrompts[1])
    expect(retryPrompts[0]?.match(/<sixb_tool_files/g)).toHaveLength(1)
  })

  test("cancels an in-flight blob projection", async () => {
    const fileRef: FileRef = {
      blobId: `blob_${"a".repeat(64)}`,
      digest: `sha256:${"a".repeat(64)}`,
      sizeBytes: PNG_BYTES.byteLength,
      fileName: "generated.png",
      mediaType: "image/png",
    }
    const opened = Promise.withResolvers<void>()
    let streamCancelled = false
    const blobStorage: BlobStorage = {
      async put() {
        throw new Error("unused")
      },
      async stat() {
        return {
          blobId: fileRef.blobId,
          digest: fileRef.digest,
          sizeBytes: fileRef.sizeBytes,
        }
      },
      async open() {
        return new ReadableStream<Uint8Array>({
          pull() {
            opened.resolve()
          },
          cancel() {
            streamCancelled = true
          },
        })
      },
    }
    const bridge = new AgentToolResultMediaBridge({ blobStorage })
    const abort = new AbortController()
    await bridge.toModelOutput({
      output: richImageResult(fileRef),
      signal: abort.signal,
      toolCallId: "image-call-cancel",
    })

    const projection = prepareBridge(bridge, imageModel(), [])
    await opened.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const reason = new Error("stop projection")
    abort.abort(reason)

    await expect(projection).rejects.toBe(reason)
    expect(streamCancelled).toBe(true)
  })
})

const MODEL_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function modelStream(chunks: LanguageModelV4StreamPart[]) {
  return { stream: convertArrayToReadableStream(chunks) }
}

function modelFinish(unified: "stop" | "tool-calls"): LanguageModelV4StreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage: MODEL_USAGE }
}

function richImageResult(fileRef: FileRef): JsonValue {
  return {
    kind: "agentToolResult",
    content: [
      { type: "text", text: "Created the image." },
      { type: "file", fileRef: { ...fileRef } },
    ],
  }
}

async function storeImage(blobStorage: InMemoryBlobStorage): Promise<FileRef> {
  return blobStorage.put({
    body: PNG_BYTES,
    fileName: "generated.png",
    mediaType: "image/png",
  })
}

function imageModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({ supportedUrls: { "image/*": [/^data:/] } })
}

function textModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({ supportedUrls: {} })
}

async function prepareBridge(
  bridge: AgentToolResultMediaBridge,
  model: LanguageModel,
  messages: ModelMessage[]
) {
  return bridge.prepareStep({
    steps: [],
    stepNumber: 1,
    model,
    instructions: undefined,
    initialInstructions: undefined,
    messages,
    initialMessages: messages,
    responseMessages: [],
    toolsContext: {},
    runtimeContext: {},
  })
}
