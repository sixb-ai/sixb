import { describe, expect, test } from "bun:test"
import type { BlobStorage, FileRef, JsonValue } from "@sixb/core"
import { InMemoryBlobStorage } from "@sixb/core"
import type { LanguageModel, ModelMessage } from "@sixb/core/models"
import type { AgentMessageRecord } from "@sixb/core/storage"
import type { PendingAttachmentImage, PreparedAgentAttachmentContext } from "../src/attachments"
import { InlineImageBudget, projectInOrder } from "../src/inline-images"
import {
  AgentToolResultMediaBridge,
  allocateInlineImages,
  replayToolFiles,
  toolFilesStepKey,
} from "../src/tools/result-media"
import { WorkerTestModel } from "./worker-model-fixture"

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe("agent tool-result media bridge", () => {
  test("keeps durable tool results text-only and injects one image into the next model call", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await storeImage(blobStorage)
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      suppliesToolFiles: () => true,
      inlineImages: new InlineImageBudget(),
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
    })

    expect(projected.type).toBe("text")
    expect(JSON.stringify(projected)).toContain("Created the image.")
    expect(JSON.stringify(projected)).not.toContain('"type":"file"')
    expect(JSON.stringify(projected)).toContain("sandboxPath")
    expect(JSON.stringify(projected)).toContain("not embedded in the tool-result message")

    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Create an image." }] },
      ...stepWith([{ toolCallId: "image-call-1", output: richImageResult(fileRef) }]),
    ]
    const prepared = await prepareBridge(bridge, imageModel(), messages)
    expect(prepared?.messages).toHaveLength(4)
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
    // A history the loop starts on holds its own steps' images already.
    await expect(prepareBridge(bridge, imageModel(), messages, 0)).resolves.toBeUndefined()
  })

  test("uses metadata and the sandbox path when the selected model cannot accept images", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await storeImage(blobStorage)
    let projections = 0
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      suppliesToolFiles: () => true,
      inlineImages: new InlineImageBudget(),
      sandboxPathForFileRef: () => "/workspace/generated.png",
      projectFile: async () => {
        projections += 1
        throw new Error("An unsupported model must not project image bytes.")
      },
    })
    const projected = await bridge.toModelOutput({
      output: richImageResult(fileRef),
      signal: new AbortController().signal,
    })

    await expect(
      prepareBridge(
        bridge,
        textModel(),
        stepWith([{ toolCallId: "image-call-2", output: richImageResult(fileRef) }])
      )
    ).resolves.toBeUndefined()
    expect(projections).toBe(0)
    expect(JSON.stringify(projected)).toContain("/workspace/generated.png")
    expect(JSON.stringify(projected)).not.toContain("data:image")
  })

  test("deduplicates identical file content returned by parallel tool calls", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await storeImage(blobStorage)
    let projections = 0
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      suppliesToolFiles: () => true,
      inlineImages: new InlineImageBudget(),
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

    const prepared = await prepareBridge(
      bridge,
      imageModel(),
      stepWith([
        { toolCallId: "call-1", output: richImageResult(fileRef) },
        { toolCallId: "call-2", output: richImageResult(fileRef) },
      ])
    )
    expect(projections).toBe(1)
    expect(prepared?.messages?.at(-1)?.content).toHaveLength(2)
    expect(prepared?.messages?.at(-1)?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('toolCallIds="call-1"'),
    })
  })

  // Removal proof: drop the suppliesToolFiles check in toolFilesMessage; wait_agent's image, which
  // its own output never showed the model, joins the message. The images follow the step's calls,
  // not the order the parallel calls finished in, so a replay derives the same message.
  test("follows the step's call order, and only tools whose files reach the model", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const first = await storeImage(blobStorage, "first.png")
    const second = await storeImage(blobStorage, "second.png", Uint8Array.of(1, 2, 3))
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      suppliesToolFiles: (toolName) => toolName !== "wait_agent",
      inlineImages: new InlineImageBudget(),
      projectFile: async ({ fileRef }) => ({
        promptText: "projected",
        modelFileData: {
          data: new URL(`data:image/png;base64,${btoa(fileRef.fileName ?? "")}`),
          mediaType: "image/png",
          ...(fileRef.fileName === undefined ? {} : { filename: fileRef.fileName }),
        },
      }),
    })

    const prepared = await prepareBridge(
      bridge,
      imageModel(),
      stepWith([
        { toolCallId: "first", output: richImageResult(first) },
        { toolCallId: "waited", toolName: "wait_agent", output: richImageResult(second) },
        { toolCallId: "second", output: richImageResult(second) },
      ])
    )

    expect(prepared?.messages?.at(-1)?.content).toMatchObject([
      { type: "text", text: expect.stringContaining('toolCallIds="first,second"') },
      { type: "file", filename: "first.png" },
      { type: "file", filename: "second.png" },
    ])
  })

  // Removal proof: return an empty map from replayToolFiles; the stored step loses the
  // images that followed it live, and the request after it shifts.
  test("derives the same message again from the stored step", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await storeImage(blobStorage)
    const input = {
      blobStorage,
      suppliesToolFiles: (toolName: string) => toolName === "make",
      projectFile: async () => ({
        promptText: "projected",
        modelFileData: {
          data: new URL("data:image/png;base64,iVBORw0KGgo="),
          mediaType: "image/png",
          filename: "generated.png",
        },
      }),
    }
    const bridge = new AgentToolResultMediaBridge({
      ...input,
      inlineImages: new InlineImageBudget(),
    })
    const output = richImageResult(fileRef)
    const live = await prepareBridge(
      bridge,
      imageModel(),
      stepWith([{ toolCallId: "make-1", toolName: "make", output }])
    )

    const messages = [
      storedStep("assistant-1", [{ toolCallId: "make-1", toolName: "make", output }]),
    ]
    const replayed = await allocateInlineImages({
      ...input,
      messages,
      attachments: attachmentsOf([]),
      toolFiles: replayToolFiles({ ...input, supportsImages: true, messages }),
      budget: new InlineImageBudget(),
      signal: new AbortController().signal,
    })

    const liveMessage = live?.messages?.at(-1)
    if (!liveMessage) throw new Error("Expected the step's images after it.")
    expect([...(replayed.toolFilesByStep ?? new Map()).entries()]).toEqual([
      [toolFilesStepKey("assistant-1", 2), liveMessage],
    ])
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
    const bridge = new AgentToolResultMediaBridge({
      blobStorage,
      suppliesToolFiles: () => true,
      inlineImages: new InlineImageBudget(),
    })

    const projection = bridge.prepareStep({
      stepIndex: 1,
      model: imageModel(),
      messages: stepWith([{ toolCallId: "image-call-cancel", output: richImageResult(fileRef) }]),
      steps: [],
      signal: abort.signal,
    })
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

describe("a request's inline image budget", () => {
  // Removal proofs: drop the byte or the image limit from InlineImageBudget.take, or let a refusal
  // leave it open; an image past the limit goes in, or a later smaller one does.
  test("holds 16 MiB of encoded images and 100 images, and closes at the first that does not fit", () => {
    const budget = new InlineImageBudget()

    expect(budget.take(dataUrl(10 * MiB))).toBe(true)
    expect(budget.take(dataUrl(7 * MiB))).toBe(false)
    expect(budget.closed).toBe(true)
    expect(budget.take(dataUrl(10))).toBe(false)

    const count = new InlineImageBudget()
    const taken = Array.from({ length: 101 }, () => count.take(dataUrl(10)))
    expect(taken.filter(Boolean)).toHaveLength(100)
  })

  // Removal proofs: skip budget.take in decideAttachment, and the attachments past the budget go
  // inline anyway; skip it in decideToolFile, and the live step inlines an image past the budget.
  test("keeps each image's decision from its own turn on, live and on replay", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const shot = await storeImage(blobStorage, "shot.png")
    const chart = await storeImage(blobStorage, "chart.png", Uint8Array.of(1, 2, 3))
    const sizes: Record<string, number> = {
      "shot.png": Math.floor(0.5 * MiB),
      "chart.png": Math.floor(0.6 * MiB),
    }
    const input = {
      blobStorage,
      suppliesToolFiles: () => true,
      projectFile: async ({ fileRef }: { readonly fileRef: FileRef }) => ({
        promptText: "projected",
        modelFileData: {
          data: dataUrl(sizes[fileRef.fileName ?? ""] ?? 0),
          mediaType: "image/png",
          ...(fileRef.fileName === undefined ? {} : { filename: fileRef.fileName }),
        },
      }),
    }
    const output = (fileRef: FileRef) => richImageResult(fileRef)
    const step = [
      { toolCallId: "shot", output: output(shot) },
      { toolCallId: "chart", output: output(chart) },
    ]
    const thread = [
      userImages("user-1", 5 * MiB, 5 * MiB, 5 * MiB),
      storedStep("assistant-2", step),
      userImages("user-3", Math.floor(0.4 * MiB)),
      record("assistant-4", "assistant", [{ type: "text", text: "Seen." }]),
      userImages("user-5", 1 * MiB),
    ]
    const turn = async (messages: readonly AgentMessageRecord[]) => {
      const budget = new InlineImageBudget()
      const context = await allocateInlineImages({
        ...input,
        messages,
        attachments: attachmentsOf(messages),
        toolFiles: replayToolFiles({ ...input, supportsImages: true, messages }),
        budget,
        signal: new AbortController().signal,
      })
      return { budget, context }
    }

    // Live: the turn answering user-1 runs the step on what the attachments left.
    const first = await turn(thread.slice(0, 1))
    const bridge = new AgentToolResultMediaBridge({ ...input, inlineImages: first.budget })
    const live = (await prepareBridge(bridge, imageModel(), stepWith(step)))?.messages?.at(-1)
    if (live?.role !== "user") throw new Error("Expected the step's images after it.")
    expect(live.content.map((part) => part.type)).toEqual(["text", "file", "text"])
    expect(JSON.stringify(live.content.at(-1))).toContain("Images not inlined: chart.png")

    // Every later turn takes the same decisions, and decides a new image once, when it comes.
    const later = await turn(thread.slice(0, 3))
    const last = await turn(thread)
    for (const { context } of [later, last]) {
      expect(context.toolFilesByStep?.get(toolFilesStepKey("assistant-2", 2))).toEqual(live)
      expect([...context.modelFileDataByPartKey.keys()]).toEqual([
        "user-1:0",
        "user-1:1",
        "user-1:2",
      ])
      // The budget closed at the chart: a smaller image after it stays out too.
      expect(context.promptTextByPartKey.get("user-3:0")).toBe("user-3:0 budget")
    }
    expect(last.context.promptTextByPartKey.get("user-5:0")).toBe("user-5:0 budget")
  })

  // Removal proofs: project every image before deciding any (drop the closed check in
  // projectInOrder), and the images past the budget are projected too; await each projection
  // before starting the next, and only one runs at a time.
  test("projects a few images at a time, decides them in order, and none once it closes", async () => {
    const settled: string[] = []
    let running = 0
    let mostRunning = 0
    const projected: number[] = []
    const items = Array.from({ length: 20 }, (_, index) => index)
    const budget = new InlineImageBudget()

    await projectInOrder({
      items,
      budget,
      project: async (index) => {
        projected.push(index)
        running += 1
        mostRunning = Math.max(mostRunning, running)
        // Later images finish first: decisions still follow the items' order.
        for (let tick = 0; tick <= (20 - index) % 4; tick += 1) await Promise.resolve()
        running -= 1
        return dataUrl(index === 5 ? 17 * MiB : 1_000)
      },
      decide: (index, data) => {
        settled.push(`${index}:${data === undefined ? "skipped" : budget.take(data)}`)
      },
    })

    expect(settled.slice(0, 6)).toEqual([
      "0:true",
      "1:true",
      "2:true",
      "3:true",
      "4:true",
      "5:false",
    ])
    expect(settled.slice(6)).toEqual(items.slice(6).map((index) => `${index}:skipped`))
    expect(mostRunning).toBe(4)
    expect(Math.max(...projected)).toBeLessThan(9)
  })
})

const MiB = 1024 * 1024

/** A data URL of exactly `bytes` characters. */
function dataUrl(bytes: number): URL {
  const prefix = "data:image/png;base64,"
  return new URL(`${prefix}${"A".repeat(Math.max(0, bytes - prefix.length))}`)
}

function record(
  id: string,
  role: AgentMessageRecord["role"],
  parts: AgentMessageRecord["parts"]
): AgentMessageRecord {
  return {
    id,
    projectId: "project",
    threadId: "thread",
    runId: role === "assistant" ? `run-${id}` : null,
    role,
    seq: Number(id.replace(/\D/g, "")),
    contentVersion: 2,
    createdAt: new Date(0),
    parts,
  }
}

/** A user message with one image per size, each encoded to a data URL of that many bytes. */
function userImages(id: string, ...sizes: number[]): AgentMessageRecord {
  return record(
    id,
    "user",
    sizes.map((size, index) => ({
      type: "file" as const,
      fileRef: {
        blobId: `blob_${id}_${index}`,
        digest: `sha256:${id}${index}`,
        sizeBytes: size,
        fileName: `${id}-${index}.png`,
        mediaType: "image/png",
      },
    }))
  )
}

/**
 * The attachments a thread's user images project to, each inline at its size when projected. Each
 * reads as `<key> <outcome>`.
 */
function attachmentsOf(messages: readonly AgentMessageRecord[]): PreparedAgentAttachmentContext {
  const entries = messages.flatMap((message) =>
    message.parts.flatMap((part, partIndex) =>
      part.type === "file" && message.role === "user"
        ? [
            {
              key: `${message.id}:${partIndex}`,
              messageId: message.id,
              partIndex,
              fileRef: part.fileRef,
              fileName: part.fileRef.fileName ?? "image.png",
              mediaType: "image/png",
              sizeBytes: part.fileRef.sizeBytes,
              contentPath: `/parts/${partIndex}/fileRef`,
              contentUrl: `http://sixb.test/${message.id}/${partIndex}`,
              inlineDisposition: "metadata-only" as const,
              notes: [],
            },
          ]
        : []
    )
  )
  const pendingImages = new Map(
    entries.map((entry): [string, PendingAttachmentImage] => [
      entry.key,
      {
        project: async () => ({
          kind: "inline",
          data: { data: dataUrl(entry.sizeBytes), mediaType: "image/png" },
          notes: [],
        }),
        settle: (outcome) => ({
          entry,
          promptText: `${entry.key} ${outcome.kind}`,
          ...(outcome.kind === "inline" ? { modelFileData: outcome.data } : {}),
        }),
      },
    ])
  )
  return {
    entries,
    promptTextByPartKey: new Map(entries.map((entry) => [entry.key, `${entry.key} pending`])),
    modelFileDataByPartKey: new Map(),
    sandboxFiles: [],
    manifestJson: JSON.stringify({ projectId: "project", attachments: [] }),
    pendingImages,
  }
}

/** A stored assistant message holding one step that ran these calls. */
function storedStep(
  id: string,
  results: readonly { toolCallId: string; toolName?: string; output: JsonValue }[]
): AgentMessageRecord {
  return record(id, "assistant", [
    { type: "step-start" },
    { type: "text", text: "Making it." },
    ...results.map(({ toolCallId, toolName = "make", output }) => ({
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input: {},
      state: "output-available" as const,
      output,
    })),
    { type: "step-start" },
    { type: "text", text: "Done." },
  ])
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

async function storeImage(
  blobStorage: InMemoryBlobStorage,
  fileName = "generated.png",
  body = PNG_BYTES
): Promise<FileRef> {
  return blobStorage.put({ body, fileName, mediaType: "image/png" })
}

/** A step that ran these calls, as the loop leaves it: the model's calls, then their results. */
function stepWith(
  results: readonly { toolCallId: string; toolName?: string; output: JsonValue }[]
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: results.map(({ toolCallId, toolName = "make" }) => ({
        type: "tool-call" as const,
        toolCallId,
        toolName,
        input: {},
      })),
    },
    {
      role: "tool",
      content: results.map(({ toolCallId, toolName = "make", output }) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output: { type: "text" as const, value: "projected" },
        originalOutput: output,
      })),
    },
  ]
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
  messages: readonly ModelMessage[],
  stepIndex = 1
) {
  return bridge.prepareStep({
    stepIndex,
    model,
    messages,
    steps: [],
    signal: new AbortController().signal,
  })
}
