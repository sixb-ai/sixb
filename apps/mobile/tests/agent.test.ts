import { describe, expect, test } from "bun:test"
import { isImage, messageFileUrl, uploadName } from "../src/lib/agent/files"
import { chatTitle, firstMessageTitle } from "../src/lib/agent/titles"
import {
  type AgentMessage,
  type AgentMessagePart,
  messageFiles,
  messageText,
  normalizeMessageParts,
} from "../src/lib/agent/types"

const photo = { blobId: "blob-1", digest: "sha256:1", sizeBytes: 2048, mediaType: "image/jpeg" }

function message(parts: AgentMessagePart[]): AgentMessage {
  return {
    id: "message-1",
    projectId: "project",
    threadId: "thread-1",
    runId: null,
    role: "user",
    seq: 1,
    parts,
    annotations: [],
    contentVersion: 1,
    createdAt: "2026-10-10T09:30:00.000Z",
  }
}

describe("uploadName", () => {
  // A space reached the API as "%20" and came back that way in the file's name.
  test("replaces what a multipart filename would percent-encode", () => {
    expect(uploadName("Screen Shot 2026-10-10 at 9.30.png")).toBe(
      "Screen-Shot-2026-10-10-at-9.30.png"
    )
    expect(uploadName("résumé (final).pdf")).toBe("r-sum-final-.pdf")
    expect(uploadName("report_v2-final.csv")).toBe("report_v2-final.csv")
  })

  test("never sends an empty name", () => {
    expect(uploadName("日本語")).toBe("file")
    expect(uploadName("")).toBe("file")
  })
})

describe("messageFileUrl", () => {
  test("names the file by its message and its place among the parts", () => {
    const url = new URL(
      messageFileUrl("http://localhost:3002", { threadId: "thread/1", id: "message 1" }, 2)
    )

    expect(url.origin).toBe("http://localhost:3002")
    expect(url.pathname).toBe("/api/agent-threads/thread%2F1/messages/message%201/files/content")
    expect(url.searchParams.get("path")).toBe("/parts/2/fileRef")
    expect(url.searchParams.get("disposition")).toBe("inline")
  })
})

describe("isImage", () => {
  test("goes by the media type", () => {
    expect(isImage("image/heic")).toBe(true)
    expect(isImage("application/pdf")).toBe(false)
    expect(isImage(undefined)).toBe(false)
  })
})

describe("titles", () => {
  test("titles a new chat with the first line of its first message", () => {
    expect(firstMessageTitle("Summarize Q3\n\nFocus on churn.")).toBe("Summarize Q3")
    expect(firstMessageTitle("  Summarize Q3  ")).toBe("Summarize Q3")
  })

  test("cuts a long first line to sixty characters, ellipsis included", () => {
    const title = firstMessageTitle("a".repeat(80))
    expect(title).toBe(`${"a".repeat(59)}…`)
    expect(firstMessageTitle("a".repeat(60))).toBe("a".repeat(60))
  })

  test("shows a fallback for a chat without a title", () => {
    expect(chatTitle({ title: " Churn review " })).toBe("Churn review")
    expect(chatTitle({ title: "  " })).toBe("Untitled chat")
    expect(chatTitle({})).toBe("Untitled chat")
    expect(chatTitle(null, "New chat")).toBe("New chat")
  })
})

describe("message parts", () => {
  test("keeps what a reader sees and drops the model's bookkeeping", () => {
    const parts = normalizeMessageParts([
      { type: "step-start" },
      { type: "reasoning", text: "Check the ledger." },
      { type: "text", text: "Revenue rose 4%." },
      { type: "provider-state", providerId: "anthropic", data: null },
      { type: "file", fileRef: photo },
    ])

    expect(parts).toEqual([
      { kind: "reasoning", text: "Check the ledger.", streaming: false },
      { kind: "text", text: "Revenue rose 4%." },
      // Its index among the saved parts, which the download URL names.
      { kind: "file", fileRef: photo, partIndex: 4 },
    ])
  })

  test("lists a message's files with where each sits", () => {
    const sent = message([
      { type: "text", text: "What is this?" },
      { type: "file", fileRef: photo },
      { type: "file", fileRef: { ...photo, blobId: "blob-2" } },
    ])

    expect(messageFiles(sent)).toEqual([
      { fileRef: photo, partIndex: 1 },
      { fileRef: { ...photo, blobId: "blob-2" }, partIndex: 2 },
    ])
  })

  test("joins a message's text parts for a bubble", () => {
    const sent = message([
      { type: "text", text: "First line" },
      { type: "file", fileRef: photo },
      { type: "text", text: "Second line\n" },
    ])
    expect(messageText(sent)).toBe("First line\nSecond line")
  })
})
