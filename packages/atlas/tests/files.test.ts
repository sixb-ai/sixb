import { describe, expect, test } from "bun:test"
import { type FileRef, fileNameFor } from "@sixb/core/blob-storage"
import {
  actionRunFileContentUrl,
  classifyFileValue,
  fileMediaLabel,
  formatFileSize,
  workflowNodeFileContentUrl,
  workflowRunFileContentUrl,
} from "../src/lib/files"
import { valueSchema } from "../src/lib/valueSchema"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 7789,
  fileName: "download.jpeg",
  mediaType: "image/jpeg",
  logicalPath: "docs/download.jpeg",
}

describe("Atlas file helpers", () => {
  test("classifies declared file values with narrowed refs", () => {
    const single = valueSchema("fileRef")
    const list = valueSchema({ type: "array", items: "fileRef" })
    expect(classifyFileValue(fileRef, single)).toEqual({ kind: "single", fileRef })
    expect(classifyFileValue([fileRef], list)).toEqual({ kind: "array", fileRefs: [fileRef] })
    expect(classifyFileValue([], list).kind).toBe("none")
    expect(classifyFileValue({ ...fileRef, sizeBytes: "7789" }, single).kind).toBe("none")
    // A blobId that is not derivable from the digest is not a valid reference.
    expect(classifyFileValue({ ...fileRef, blobId: "blob_tampered" }, single).kind).toBe("none")
    // A mixed array is not treated as a file list.
    expect(classifyFileValue([fileRef, "not-a-file"], list).kind).toBe("none")
  })

  test("never classifies a FileRef-shaped value declared as something else", () => {
    const record = valueSchema({
      type: "object",
      properties: Object.fromEntries(
        Object.keys(fileRef).map((key) => [key, { schema: "string" }])
      ),
    })
    expect(classifyFileValue(fileRef, record).kind).toBe("none")
    expect(classifyFileValue([fileRef], valueSchema({ type: "array", items: "string" })).kind).toBe(
      "none"
    )
    // A schema Atlas cannot read is not a license to guess.
    expect(classifyFileValue(fileRef, valueSchema(undefined)).kind).toBe("none")
    expect(
      classifyFileValue(fileRef, valueSchema({ type: "valueTypeRef", valueTypeId: "Unknown" })).kind
    ).toBe("none")
  })

  test("follows value type refs to a declared file", () => {
    const attachment = valueSchema({ type: "valueTypeRef", valueTypeId: "Attachment" })
    expect(classifyFileValue(fileRef, attachment).kind).toBe("none")
    expect(
      classifyFileValue(
        fileRef,
        valueSchema(attachment.schema, new Map([["Attachment", "fileRef"]]))
      )
    ).toEqual({ kind: "single", fileRef })
  })

  test("builds run-bound file content URLs", () => {
    expect(
      actionRunFileContentUrl({
        baseUrl: "https://atlas.test/app",
        runId: "act/1",
        pathSegments: ["source/pdf"],
      })
    ).toBe(
      "https://atlas.test/api/action-runs/act%2F1/files/content?path=%2Fparams%2Fsource%7E1pdf"
    )

    expect(
      workflowRunFileContentUrl({
        baseUrl: "https://atlas.test/app",
        runId: "wf/1",
        pathSegments: ["input~file"],
        disposition: "attachment",
      })
    ).toBe(
      "https://atlas.test/api/workflow-runs/wf%2F1/files/content?path=%2Finput%2Finput%7E0file&disposition=attachment"
    )

    expect(
      workflowNodeFileContentUrl({
        baseUrl: "https://atlas.test/app",
        runId: "wf/1",
        nodeKey: "extract/report",
        root: "output",
        pathSegments: ["report"],
      })
    ).toBe(
      "https://atlas.test/api/workflow-runs/wf%2F1/nodes/extract%2Freport/files/content?path=%2Foutput%2Freport"
    )
  })

  test("formats file names, media labels, and sizes", () => {
    expect(fileNameFor(fileRef)).toBe("download.jpeg")
    expect(fileNameFor({ ...fileRef, fileName: undefined, logicalPath: "reports/q3.pdf" })).toBe(
      "q3.pdf"
    )
    expect(fileMediaLabel("application/pdf", "q3.pdf")).toBe("PDF")
    expect(fileMediaLabel("text/markdown", "readme.md")).toBe("Markdown")
    expect(fileMediaLabel("image/jpeg", "download.jpg")).toBe("JPEG image")
    expect(formatFileSize(7789)).toBe("7.6 KB")
    expect(formatFileSize(-1)).toBe("Unknown size")
  })
})
