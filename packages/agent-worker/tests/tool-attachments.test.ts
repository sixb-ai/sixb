import { describe, expect, test } from "bun:test"
import {
  type AgentToolAttachments,
  AgentToolPublicError,
  type FileRef,
  InMemoryBlobStorage,
  InMemoryStorage,
  type JsonValue,
  type OpenedFileRef,
} from "@sixb/core"
import type { AgentStorage } from "@sixb/core/storage"
import { attachmentKey, toolResultAttachmentKey } from "../src/attachments"
import {
  NO_TOOL_ATTACHMENTS,
  threadToolAttachments,
  workflowInputToolAttachments,
} from "../src/tools/attachments"

const PROJECT_ID = "tool-attachments"
const OWNER = { type: "user", id: "usr_owner" } as const
const encoder = new TextEncoder()

/** Stored records hold FileRefs as plain JSON. */
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

async function text(file: Promise<OpenedFileRef | null>) {
  const opened = await file
  return opened && { name: opened.fileRef.fileName, text: await new Response(opened.body).text() }
}

async function seedThreads() {
  const storage = new InMemoryStorage()
  const agents = storage.agents as AgentStorage
  const blobStorage = new InMemoryBlobStorage()
  const put = (body: string, fileName: string) =>
    blobStorage.put({ body: encoder.encode(body), fileName, mediaType: "text/plain" })
  const appendFile = async (threadId: string, id: string, fileRef: FileRef) => {
    await agents.threads.create({ id: threadId, projectId: PROJECT_ID, ownerPrincipal: OWNER })
    await agents.messages.append({
      id,
      projectId: PROJECT_ID,
      threadId,
      runId: null,
      role: "user",
      parts: [
        { type: "text", text: "See attached." },
        { type: "file", fileRef },
      ],
    })
  }
  await appendFile("thread-1", "msg-1", await put("quote", "quote.txt"))
  await appendFile("thread-2", "msg-2", await put("other", "other.txt"))
  await agents.messages.append({
    id: "msg-3",
    projectId: PROJECT_ID,
    threadId: "thread-1",
    runId: null,
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "render",
        input: {},
        state: "output-available",
        output: {
          kind: "agentToolResult",
          content: [{ type: "file", fileRef: json(await put("rendered", "rendered.txt")) }],
        },
      },
    ],
  })
  // Plain JSON output is not an agent tool result, so its FileRef is not an attachment.
  await agents.messages.append({
    id: "msg-4",
    projectId: PROJECT_ID,
    threadId: "thread-1",
    runId: null,
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "lookup",
        input: {},
        state: "output-available",
        output: { content: [{ type: "file", fileRef: json(await put("plain", "plain.txt")) }] },
      },
    ],
  })
  const attachments = threadToolAttachments({
    storage: agents,
    projectId: PROJECT_ID,
    threadId: "thread-1",
    blobStorage,
  })
  return { attachments, blobStorage }
}

async function expectRejected(attachments: AgentToolAttachments, attachmentId: string) {
  await expect(attachments.open(attachmentId)).rejects.toThrow(AgentToolPublicError)
}

describe("tool attachments", () => {
  test("opens the files of the run's thread by their manifest key", async () => {
    const { attachments } = await seedThreads()

    await expect(text(attachments.open(attachmentKey("msg-1", 1)))).resolves.toEqual({
      name: "quote.txt",
      text: "quote",
    })
    await expect(text(attachments.open(toolResultAttachmentKey("msg-3", 0, 0)))).resolves.toEqual({
      name: "rendered.txt",
      text: "rendered",
    })
  })

  // Regression proof: drop the thread check in tools/attachments.ts, or the `isAgentToolResult`
  // check in attachments.ts; the other thread's file, or the plain JSON one, then opens.
  test("rejects keys the manifest cannot list", async () => {
    const { attachments } = await seedThreads()

    await expectRejected(attachments, toolResultAttachmentKey("msg-4", 0, 0))
    await expectRejected(attachments, attachmentKey("msg-2", 1))
    await expectRejected(attachments, attachmentKey("msg-1", 0))
    await expectRejected(attachments, attachmentKey("missing", 1))
    await expectRejected(attachments, "../../thread-2/msg-2:1")
    await expectRejected(attachments, "msg-1")
  })

  test("returns null when the stored file no longer matches the attachment", async () => {
    const storage = new InMemoryStorage()
    const agents = storage.agents as AgentStorage
    await agents.threads.create({ id: "thread-1", projectId: PROJECT_ID, ownerPrincipal: OWNER })
    await agents.messages.append({
      id: "msg-1",
      projectId: PROJECT_ID,
      threadId: "thread-1",
      runId: null,
      role: "user",
      parts: [
        {
          type: "file",
          fileRef: {
            blobId: `blob_${"0".repeat(64)}`,
            digest: `sha256:${"0".repeat(64)}`,
            sizeBytes: 1,
          },
        },
      ],
    })
    const attachments = threadToolAttachments({
      storage: agents,
      projectId: PROJECT_ID,
      threadId: "thread-1",
      blobStorage: new InMemoryBlobStorage(),
    })

    await expect(attachments.open(attachmentKey("msg-1", 0))).resolves.toBeNull()
  })

  test("opens a workflow task's input files by their path", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const invoice = await blobStorage.put({ body: encoder.encode("invoice"), fileName: "inv.pdf" })
    const attachments = workflowInputToolAttachments({
      input: json({ invoice, pages: [invoice] }) as Record<string, JsonValue>,
      blobStorage,
    })

    await expect(text(attachments.open("input.invoice"))).resolves.toEqual({
      name: "inv.pdf",
      text: "invoice",
    })
    await expect(text(attachments.open("input.pages[0]"))).resolves.toMatchObject({
      text: "invoice",
    })
    await expectRejected(attachments, "input.pages[1]")
  })

  test("gives a child Agent no attachments", async () => {
    await expectRejected(NO_TOOL_ATTACHMENTS, attachmentKey("msg-1", 1))
  })
})
