import { describe, expect, test } from "bun:test"
import {
  type FileRefValue,
  fileMediaLabel,
  fileRefName,
  formatFileSize,
  isFileRefDisplayValue,
  objectFileContentUrl,
} from "../src/lib/files"

const fileRef: FileRefValue = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 7789,
  fileName: "download.jpeg",
  mediaType: "image/jpeg",
  logicalPath: "docs/download.jpeg",
}

describe("Atlas file helpers", () => {
  test("detects FileRef display values", () => {
    expect(isFileRefDisplayValue(fileRef)).toBe(true)
    expect(isFileRefDisplayValue([fileRef])).toBe(true)
    expect(isFileRefDisplayValue([])).toBe(false)
    expect(isFileRefDisplayValue({ ...fileRef, sizeBytes: "7789" })).toBe(false)
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

  test("formats file names, media labels, and sizes", () => {
    expect(fileRefName(fileRef)).toBe("download.jpeg")
    expect(fileRefName({ ...fileRef, fileName: undefined, logicalPath: "reports/q3.pdf" })).toBe(
      "q3.pdf"
    )
    expect(fileMediaLabel("application/pdf", "q3.pdf")).toBe("PDF")
    expect(fileMediaLabel("text/markdown", "readme.md")).toBe("Markdown")
    expect(fileMediaLabel("image/jpeg", "download.jpg")).toBe("JPEG image")
    expect(formatFileSize(7789)).toBe("7.6 KB")
    expect(formatFileSize(-1)).toBe("Unknown size")
  })
})
