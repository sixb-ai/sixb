import { describe, expect, test } from "bun:test"
import { type FileRef, fileNameFor } from "@sixb/core/blob-storage"
import {
  actionRunFileContentUrl,
  classifyFileValue,
  fileMediaLabel,
  formatFileSize,
  objectFileContentUrl,
  workflowNodeFileContentUrl,
  workflowRunFileContentUrl,
} from "../src/lib/files"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 7789,
  fileName: "download.jpeg",
  mediaType: "image/jpeg",
  logicalPath: "docs/download.jpeg",
}

describe("Atlas file helpers", () => {
  test("classifies single, array, and non-file values with narrowed refs", () => {
    expect(classifyFileValue(fileRef)).toEqual({ kind: "single", fileRef })
    expect(classifyFileValue([fileRef])).toEqual({ kind: "array", fileRefs: [fileRef] })
    expect(classifyFileValue([]).kind).toBe("none")
    expect(classifyFileValue({ ...fileRef, sizeBytes: "7789" }).kind).toBe("none")
    // A blobId that is not derivable from the digest is not a valid reference.
    expect(classifyFileValue({ ...fileRef, blobId: "blob_tampered" }).kind).toBe("none")
    // A mixed array is not treated as a file list.
    expect(classifyFileValue([fileRef, "not-a-file"]).kind).toBe("none")
  })

  test("builds object-bound file content URLs with JSON pointer escaping", () => {
    const url = objectFileContentUrl({
      baseUrl: "https://atlas.test/app",
      context: {
        objectTypeId: "document type",
        primaryId: "doc/1",
        pathSegments: ["attachments", "a/b", "tilde~name"],
      },
      disposition: "attachment",
    })

    expect(url).toBe(
      "https://atlas.test/api/objects/document%20type/doc%2F1/files/content?path=%2Fproperties%2Fattachments%2Fa%7E1b%2Ftilde%7E0name&disposition=attachment"
    )
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
