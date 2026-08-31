import { describe, expect, test } from "bun:test"
import type { AgentMessagePart, FileRef, JsonValue } from "@sixb/core"
import { assistantPartsWithAttachments } from "../src/assistant-attachments"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 12,
  fileName: "generated.png",
  mediaType: "image/png",
}

describe("assistant attachments", () => {
  test("promotes rich tool files once and deduplicates collected sandbox output", () => {
    const parts: AgentMessagePart[] = [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "create_image",
        input: {},
        state: "output-available",
        output: {
          kind: "agentToolResult",
          content: [{ type: "file", fileRef: { ...fileRef } }],
        } satisfies JsonValue,
      },
      { type: "text", text: "Created the image." },
    ]

    const promoted = assistantPartsWithAttachments(parts, [
      {
        fileRef: { ...fileRef, blobId: fileRef.blobId.replace("a", "b") },
        relativePath: "generated.png",
        sandboxPath: "/workspace/generated.png",
      },
    ])

    expect(promoted.filter((part) => part.type === "file")).toEqual([{ type: "file", fileRef }])
  })
})
