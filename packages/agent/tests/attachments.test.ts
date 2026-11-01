import { describe, expect, test } from "bun:test"
import type { AgentMessagePart, BlobStorage, FileRef, JsonValue } from "@sixb/core"
import { InMemoryBlobStorage } from "@sixb/core"
import { agentToolFilePath, SANDBOX_CONTEXT_DIRECTORY } from "@sixb/core/internal/agents"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { attachmentKey, prepareAgentAttachments, toolResultAttachmentKey } from "../src/attachments"
import { INLINE_IMAGE_BUDGET_NOTE, InlineImageBudget } from "../src/inline-images"
import { allocateInlineImages } from "../src/tools/result-media"

const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  )
)
const MiB = 1024 * 1024
const encoder = new TextEncoder()

function record(
  id: string,
  role: AgentMessageRecord["role"],
  parts: readonly AgentMessagePart[]
): AgentMessageRecord {
  return {
    id,
    projectId: "project",
    threadId: "thread",
    runId: role === "assistant" ? `run-${id}` : null,
    role,
    seq: Number(id.replace(/\D/g, "")) || 1,
    parts,
    contentVersion: 2,
    createdAt: new Date(0),
  }
}

function userFiles(id: string, ...fileRefs: FileRef[]): AgentMessageRecord {
  return record(id, "user", [
    { type: "text", text: "See attached." },
    ...fileRefs.map((fileRef) => ({ type: "file" as const, fileRef })),
  ])
}

function toolFiles(
  id: string,
  toolName: string,
  toolCallId: string,
  ...fileRefs: FileRef[]
): AgentMessageRecord {
  return record(id, "assistant", [
    { type: "step-start" },
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input: {},
      state: "output-available",
      // Stored records hold FileRefs as plain JSON.
      output: JSON.parse(
        JSON.stringify({
          kind: "agentToolResult",
          content: [
            { type: "text", text: "Here." },
            ...fileRefs.map((fileRef) => ({ type: "file", fileRef })),
          ],
        })
      ) as JsonValue,
    },
  ])
}

/** The attachments as a request reads them: prepared, then their images within its budget. */
async function prepare(blobStorage: BlobStorage, messages: readonly AgentMessageRecord[]) {
  const attachments = await prepareAgentAttachments({
    projectId: "project",
    threadId: "thread",
    messages,
    blobStorage,
    apiBaseUrl: "http://sixb.test/api",
    contextDirectory: SANDBOX_CONTEXT_DIRECTORY,
    inlineImages: true,
  })
  return allocateInlineImages({
    messages,
    attachments,
    toolFiles: new Map(),
    budget: new InlineImageBudget(),
    blobStorage,
    signal: new AbortController().signal,
  })
}

/** A blob of `sizeBytes` zero bytes, as large as the sandbox limits need. */
async function large(blobStorage: BlobStorage, fileName: string, sizeBytes: number) {
  return blobStorage.put({ body: new Uint8Array(sizeBytes), fileName, mediaType: "image/png" })
}

describe("agent attachment projection", () => {
  // Removal proof: inline only the newest user message's files, as fileWorkItems once did; the
  // first message's note and image vanish once the second is sent.
  test("keeps every retained user message's files inline, as its own turn read them", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const csv = await blobStorage.put({
      body: encoder.encode("quarter,revenue\nQ3,1100\n"),
      fileName: "q3.csv",
      mediaType: "text/csv",
    })
    const png = await blobStorage.put({
      body: PNG_BYTES,
      fileName: "chart.png",
      mediaType: "image/png",
    })
    const first = userFiles("msg-1", csv, png)

    const ownTurn = await prepare(blobStorage, [first])
    const later = await prepare(blobStorage, [
      first,
      record("msg-2", "assistant", [{ type: "text", text: "Read it." }]),
      record("msg-3", "user", [{ type: "text", text: "Thanks" }]),
    ])

    const csvKey = attachmentKey("msg-1", 1)
    const pngKey = attachmentKey("msg-1", 2)
    expect(ownTurn.promptTextByPartKey.get(csvKey)).toContain("Q3,1100")
    expect(later.promptTextByPartKey.get(csvKey)).toBe(ownTurn.promptTextByPartKey.get(csvKey))
    expect(later.promptTextByPartKey.get(pngKey)).toBe(ownTurn.promptTextByPartKey.get(pngKey))
    if (typeof Bun.Image === "function") {
      expect(ownTurn.modelFileDataByPartKey.get(pngKey)).toBeDefined()
      expect(later.modelFileDataByPartKey.get(pngKey)).toEqual(
        ownTurn.modelFileDataByPartKey.get(pngKey)
      )
    }
  })

  // Removal proof: skip budget.take in decideAttachment; the 101st image reads as inline, past the
  // 100 a request takes.
  test.skipIf(typeof Bun.Image !== "function")(
    "inlines a request's first 100 images and keeps the next as metadata, saying why",
    async () => {
      const blobStorage = new InMemoryBlobStorage()
      const png = await blobStorage.put({
        body: PNG_BYTES,
        fileName: "dot.png",
        mediaType: "image/png",
      })
      const messages = Array.from({ length: 101 }, (_, index) => userFiles(`msg-${index + 1}`, png))

      const prepared = await prepare(blobStorage, messages)

      expect(prepared.modelFileDataByPartKey.size).toBe(100)
      expect(prepared.modelFileDataByPartKey.has(attachmentKey("msg-101", 1))).toBe(false)
      expect(prepared.promptTextByPartKey.get(attachmentKey("msg-101", 1))).toContain(
        INLINE_IMAGE_BUDGET_NOTE
      )
      expect(JSON.parse(prepared.manifestJson).attachments.at(-1)).toMatchObject({
        inlineDisposition: "metadata-only",
        notes: [INLINE_IMAGE_BUDGET_NOTE],
      })
      expect(prepared.pendingImages).toBeUndefined()
    }
  )

  // Removal proof: share the inline text budget across messages; the second message's file reads
  // "[File not inlined: the attachment text budget is exhausted…]" once the first used it up.
  test("gives each message its own inline text budget", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const notes = await Promise.all(
      [1, 2, 3, 4, 5].map((index) =>
        blobStorage.put({
          body: encoder.encode("x".repeat(50 * 1024)),
          fileName: `notes-${index}.txt`,
          mediaType: "text/plain",
        })
      )
    )
    const [a, b, c, d, e] = notes as [FileRef, FileRef, FileRef, FileRef, FileRef]

    const prepared = await prepare(blobStorage, [
      userFiles("msg-1", a, b, c, d),
      userFiles("msg-3", e),
    ])

    expect(prepared.promptTextByPartKey.get(attachmentKey("msg-1", 4))).toContain("<content>")
    expect(prepared.promptTextByPartKey.get(attachmentKey("msg-3", 1))).toContain("<content>")
  })

  // Removal proof: spend the sandbox budget in message order; the tool files before the user's
  // file exhaust it, and the user's file reads "[File not materialized…]" without a sandbox path.
  test("lets the user's files take the sandbox budget before any tool file", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const outputs = await Promise.all(
      [1, 2, 3, 4].map((index) => large(blobStorage, `render-${index}.png`, 25 * MiB))
    )
    const attached = await blobStorage.put({
      body: encoder.encode("hello"),
      fileName: "hello.txt",
      mediaType: "text/plain",
    })
    const user = userFiles("msg-2", attached)

    const alone = await prepare(blobStorage, [user])
    const afterTools = await prepare(blobStorage, [
      toolFiles("msg-1", "render", "render-1", ...outputs),
      user,
    ])

    const key = attachmentKey("msg-2", 1)
    expect(alone.promptTextByPartKey.get(key)).toContain('sandboxPath="')
    expect(afterTools.promptTextByPartKey.get(key)).toBe(alone.promptTextByPartKey.get(key))
    // The manifest still lists them in the thread's order.
    expect(afterTools.entries.map((entry) => entry.key)).toEqual([
      ...[1, 2, 3, 4].map((index) => toolResultAttachmentKey("msg-1", 1, index)),
      key,
    ])
  })

  // Removal proofs: materialize tool files under attachments/<message>/tool-<part>-<index>-<name>,
  // and the paths their calls' outputs named hold nothing in a later turn; drop `alreadyAt`, and
  // the attachment view_file showed is copied to a path its output never named.
  test("puts a tool file where its call's output named it, and a file already there once", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const created = await blobStorage.put({
      body: PNG_BYTES,
      fileName: "created.png",
      mediaType: "image/png",
    })
    const childFile = {
      ...(await blobStorage.put({ body: encoder.encode("rows"), fileName: "rows.csv" })),
      fileName: "acme-out-rows.csv",
      logicalPath: "acme/out/rows.csv",
    }
    const attached = await blobStorage.put({
      body: encoder.encode("hello"),
      fileName: "hello.txt",
      mediaType: "text/plain",
    })

    const prepared = await prepare(blobStorage, [
      userFiles("msg-1", attached),
      toolFiles("msg-2", "create_image", "create-1", created),
      toolFiles("msg-3", "wait_agent", "wait-1", childFile),
      toolFiles("msg-4", "view_file", "view-1", attached),
    ])

    const pathOf = (key: string) =>
      prepared.entries.find((entry) => entry.key === key)?.sandboxPath ?? "none"
    const attachedAt = pathOf(attachmentKey("msg-1", 1))
    expect(pathOf(toolResultAttachmentKey("msg-2", 1, 1))).toBe(
      `${SANDBOX_CONTEXT_DIRECTORY}/${agentToolFilePath("create-1", created, "created.png")}`
    )
    expect(pathOf(toolResultAttachmentKey("msg-3", 1, 1))).toBe(
      `${SANDBOX_CONTEXT_DIRECTORY}/children/acme/out/rows.csv`
    )
    expect(pathOf(toolResultAttachmentKey("msg-4", 1, 1))).toBe(attachedAt)
    expect(prepared.sandboxFiles.map((file) => file.path)).toEqual([
      attachedAt,
      pathOf(toolResultAttachmentKey("msg-2", 1, 1)),
      pathOf(toolResultAttachmentKey("msg-3", 1, 1)),
    ])
  })
})
