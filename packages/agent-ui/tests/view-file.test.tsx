import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { latestWorkLabel } from "../src/activity-label"
import { createAgentDocumentSource } from "../src/document-preview/source"
import { type NormalizedTool, normalizeDurableParts } from "../src/parts"
import type { AgentFileRef, AgentMessagePart } from "../src/types"
import { ViewFileToolView } from "../src/view-file/ViewFileToolView"

const page: AgentFileRef = {
  blobId: "blob-page",
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 2_048,
  fileName: "scan-page-1.png",
  mediaType: "image/png",
}

const report: AgentFileRef = {
  ...page,
  blobId: "blob-report",
  fileName: "notes.txt",
  mediaType: "text/plain",
}

function viewFileCall(fileRef: AgentFileRef): AgentMessagePart {
  return {
    type: "tool-call",
    toolCallId: "call-view",
    toolName: "view_file",
    input: { path: `inputs/${fileRef.fileName}` },
    state: "output-available",
    output: {
      kind: "agentToolResult",
      content: [
        { type: "text", text: "Prepared the file for inspection." },
        { type: "file", fileRef },
      ],
    },
  }
}

function savedTool(fileRef: AgentFileRef): NormalizedTool {
  const [part] = normalizeDurableParts([viewFileCall(fileRef)], {
    fileSource: (file, path) =>
      createAgentDocumentSource({
        threadId: "thread",
        messageId: "message",
        path,
        fileRef: file,
        baseUrl: "https://example.test",
      }),
  })
  if (part?.kind !== "tool") throw new Error("Expected a tool part.")
  return part.tool
}

describe("view_file in the work trace", () => {
  test("addresses a viewed file inside its tool result, not as a message attachment", () => {
    const tool = savedTool(page)

    expect(tool.files).toHaveLength(1)
    expect(tool.files?.[0]?.document?.path).toBe("/parts/0/output/content/1/fileRef")
  })

  test("shows a viewed image as a small preview on its row", () => {
    // Regression proof: drop `toolFiles` from normalizeDurableParts; the image has no source.
    const html = renderToStaticMarkup(<ViewFileToolView tool={savedTool(page)} />)

    expect(html).toContain("Viewed scan-page-1.png")
    expect(html).toContain("<img")
    expect(html).toContain("path=%2Fparts%2F0%2Foutput%2Fcontent%2F1%2FfileRef")
    expect(html).toContain('aria-label="Open scan-page-1.png"')
  })

  test("shows any other viewed file as a compact chip", () => {
    const html = renderToStaticMarkup(<ViewFileToolView tool={savedTool(report)} />)

    expect(html).toContain("Viewed notes.txt")
    expect(html).not.toContain("<img")
    expect(html).toContain("2 KB")
  })

  test("names the file while the call is still running", () => {
    const tool: NormalizedTool = {
      toolName: "view_file",
      state: "input-available",
      input: { path: "inputs/scan-page-1.png" },
    }

    expect(renderToStaticMarkup(<ViewFileToolView tool={tool} />)).toContain(
      "Viewing scan-page-1.png"
    )
    expect(latestWorkLabel([{ kind: "tool", tool }])).toBe("Viewing scan-page-1.png")
  })
})
