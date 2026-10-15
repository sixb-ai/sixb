import { describe, expect, test } from "bun:test"
import type { FileRef } from "@sixb/core/blob-storage"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { type WorkflowNode, workflowNodeIoSchemas } from "../src/pages/ontology/workflows/utils"
import { ValuePanel, valueSchema } from "../src/pages/values"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 7789,
  fileName: "download.jpeg",
  mediaType: "image/jpeg",
}
// Only a file card draws the file icon, and only a timestamp reads as a date.
const fileMarker = "lucide-file"

const render = (value: unknown, schema: unknown) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ValuePanel title="Value" value={value} schema={valueSchema(schema)} />
    </MemoryRouter>
  )

describe("workflow node IO schemas", () => {
  test("declares an action node's params under its recorded input, and no output", () => {
    const node = {
      type: "action",
      id: "dispatch",
      key: "dispatch",
      params: { report: "fileRef" },
    } satisfies WorkflowNode
    const io = workflowNodeIoSchemas(node)
    expect(render({ params: { report: fileRef } }, io.input)).toContain(fileMarker)
    // The subject is the run's own record, never declared, so a file-shaped one stays a record.
    expect(render({ subject: fileRef }, io.input)).not.toContain(fileMarker)
    expect(io.output).toBeNull()
  })

  test("uses an intervention's response as its output", () => {
    const node = {
      type: "intervention",
      id: "review",
      key: "review",
      input: {},
      response: { approvedAt: "timestamp" },
    } satisfies WorkflowNode
    const html = render(
      { approvedAt: "2026-10-01T12:00:00.000Z" },
      workflowNodeIoSchemas(node).output
    )
    expect(html).not.toContain(">2026-10-01T12:00:00.000Z<")
    expect(html).toContain("2026")
  })
})
