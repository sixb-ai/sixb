import { describe, expect, test } from "bun:test"
import type { BlobStorage, FileRef, JsonValue } from "@sixb/core"
import { InMemoryBlobStorage } from "@sixb/core"
import type { LanguageModel, ModelMessage } from "@sixb/core/models"
import { AgentToolResultMediaBridge } from "../src/tools/result-media"
import { WorkerTestModel } from "./worker-model-fixture"

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe("agent tool-result media bridge", () => {
  test("keeps durable tool results text-only and injects one image into the next model call", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await storeImage(blobStorage)
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      sandboxPathForFileRef: () => "/workspace/.sixb/agent/tool-files/generated.png",
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
    expect(JSON.stringify(projected)).toContain("Created the image.")
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

    // Provider retries reuse the already prepared request; a later loop step must not append it.
    await expect(
      prepareBridge(bridge, imageModel(), prepared?.messages ?? messages)
    ).resolves.toBeUndefined()
  })

  test("uses metadata and the sandbox path when the selected model cannot accept images", async () => {
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

  test("deduplicates identical file content queued by parallel tool calls", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await storeImage(blobStorage)
    let projections = 0
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      projectFile: async () => {
        projections += 1
        return {
          promptText: "projected",
          modelFileData: {
            data: new URL("data:image/png;base64,iVBORw0KGgo="),
            mediaType: "image/png",
            filename: "generated.png",
          },
        }
      },
    })
    const signal = new AbortController().signal
    await bridge.toModelOutput({ output: richImageResult(fileRef), signal, toolCallId: "call-1" })
    await bridge.toModelOutput({ output: richImageResult(fileRef), signal, toolCallId: "call-2" })

    const prepared = await prepareBridge(bridge, imageModel(), [])
    expect(projections).toBe(1)
    expect(prepared?.messages?.at(-1)?.content).toHaveLength(2)
    expect(prepared?.messages?.at(-1)?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('toolCallIds="call-1"'),
    })
  })

  // Reproduce the first row by dropping readBlobBytes's abort listener, and the second by dropping
  // its check for a cancel that came before that listener: either way the projection waits.
  test.each([
    { when: "while the blob is read", on: "pull" },
    { when: "after the blob opens, before the projection listens", on: "getReader" },
  ] as const)("cancels an in-flight blob projection $when", async ({ on }) => {
    const fileRef: FileRef = {
      blobId: `blob_${"a".repeat(64)}`,
      digest: `sha256:${"a".repeat(64)}`,
      sizeBytes: PNG_BYTES.byteLength,
      fileName: "generated.png",
      mediaType: "image/png",
    }
    const abort = new AbortController()
    const reason = new Error("stop projection")
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
        // A blob that never finishes arriving, as a stalled download does. It is pulled once read.
        const stalled = new ReadableStream<Uint8Array>(
          {
            pull() {
              if (on === "pull") abort.abort(reason)
              return new Promise(() => {})
            },
            cancel() {
              streamCancelled = true
            },
          },
          { highWaterMark: 0 }
        )
        if (on === "getReader") {
          const getReader = stalled.getReader.bind(stalled)
          Object.defineProperty(stalled, "getReader", {
            value: () => {
              abort.abort(reason)
              return getReader()
            },
          })
        }
        return stalled
      },
    }
    const bridge = new AgentToolResultMediaBridge({ blobStorage })
    await bridge.toModelOutput({
      output: richImageResult(fileRef),
      signal: abort.signal,
      toolCallId: "image-call-cancel",
    })

    const projection = prepareBridge(bridge, imageModel(), [])
    let bound: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      projection.catch((error: unknown) => error),
      new Promise((resolve) => {
        bound = setTimeout(resolve, 1_000, "still projecting")
      }),
    ]).finally(() => clearTimeout(bound))
    expect(outcome).toBe(reason)
    expect(streamCancelled).toBe(true)
  })
})

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

function imageModel(): WorkerTestModel {
  return new WorkerTestModel({ capabilities: { inputMediaTypes: ["image/png"] } })
}

function textModel(): WorkerTestModel {
  return new WorkerTestModel({ capabilities: { inputMediaTypes: [] } })
}

async function prepareBridge(
  bridge: AgentToolResultMediaBridge,
  model: LanguageModel,
  messages: readonly ModelMessage[]
) {
  return bridge.prepareStep({
    stepIndex: 1,
    model,
    messages,
    signal: new AbortController().signal,
  })
}
