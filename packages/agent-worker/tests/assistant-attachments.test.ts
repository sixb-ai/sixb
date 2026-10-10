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

const viewedRef: FileRef = {
  ...fileRef,
  blobId: fileRef.blobId.replaceAll("a", "c"),
  digest: `sha256:${"c".repeat(64)}`,
  fileName: "scan-page-1.png",
}

function toolCall(toolName: string, file: FileRef): AgentMessagePart {
  return {
    type: "tool-call",
    toolCallId: `call-${toolName}`,
    toolName,
    input: {},
    state: "output-available",
    output: {
      kind: "agentToolResult",
      content: [{ type: "file", fileRef: { ...file } }],
    } satisfies JsonValue,
  }
}

describe("assistant attachments", () => {
  test("promotes project tool files once and deduplicates collected sandbox output", () => {
    const parts: AgentMessagePart[] = [
      toolCall("create_image", fileRef),
      { type: "text", text: "Created the image." },
    ]

    const promoted = assistantPartsWithAttachments(parts, {
      projectTools: [{ name: "create_image" }],
      outputAttachments: [
        {
          fileRef: { ...fileRef, blobId: fileRef.blobId.replace("a", "b") },
          relativePath: "generated.png",
          sandboxPath: "/workspace/generated.png",
        },
      ],
    })

    expect(promoted.filter((part) => part.type === "file")).toEqual([{ type: "file", fileRef }])
  })

  test("keeps files a built-in tool only viewed in the work trace", () => {
    // Regression proof: drop the project tool check; the viewed page becomes an attachment.
    const parts: AgentMessagePart[] = [
      toolCall("view_file", viewedRef),
      { type: "text", text: "The scan shows an invoice." },
    ]

    const promoted = assistantPartsWithAttachments(parts, {
      projectTools: [{ name: "create_image" }],
    })

    expect(promoted).toEqual(parts)
  })
})
