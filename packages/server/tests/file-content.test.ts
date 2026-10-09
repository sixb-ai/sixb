import { describe, expect, test } from "bun:test"
import { type FileRef, InMemoryBlobStorage } from "@sixb/core"
import { createFileContentResponse, resolveFileRefAtPath } from "../src/files/content"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 12,
  fileName: "test.pdf",
  mediaType: "application/pdf",
}

const SANDBOXED = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

describe("file content helpers", () => {
  test("resolves FileRefs only through own JSON pointer properties", () => {
    expect(resolveFileRefAtPath({ properties: { pdf: fileRef } }, "/properties/pdf")).toEqual(
      fileRef
    )

    const inheritedObject = Object.create({ properties: { pdf: fileRef } }) as unknown
    expect(resolveFileRefAtPath(inheritedObject, "/properties/pdf")).toBeNull()

    const sparseArray = [] as unknown[]
    Object.setPrototypeOf(sparseArray, { 0: fileRef })
    expect(resolveFileRefAtPath({ files: sparseArray }, "/files/0")).toBeNull()
  })

  // The header is the last check before a browser reads the bytes, so it re-parses the type
  // instead of trusting it. Regression proof: send `fileRef.mediaType` verbatim and decide `inline`
  // with `startsWith("image/")` again; the lists then go out inline, as sent.
  test("serves one canonical type, inline only from an exact list, and never runs script", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const stored = await blobStorage.put({ body: new TextEncoder().encode("file bytes") })

    for (const [mediaType, contentType, disposition] of [
      ["image/png", "image/png", "inline"],
      ["IMAGE/PNG", "image/png", "inline"],
      ["Text/Plain; Charset=UTF-8", "text/plain;charset=UTF-8", "inline"],
      ["application/json", "application/json", "inline"],
      ["image/tiff", "image/tiff", "attachment"],
      ["image/svg+xml", "image/svg+xml", "attachment"],
      ["Image/SVG+XML; charset=utf-8", "image/svg+xml;charset=utf-8", "attachment"],
      ["text/html", "text/html", "attachment"],
      ["application/xhtml+xml", "application/xhtml+xml", "attachment"],
      ["text/xml", "text/xml", "attachment"],
      ["video/mp4", "video/mp4", "attachment"],
      ["image/png,text/html", "application/octet-stream", "attachment"],
      ["image/png, text/html", "application/octet-stream", "attachment"],
      [" image/png", "application/octet-stream", "attachment"],
      ["", "application/octet-stream", "attachment"],
      [undefined, "application/octet-stream", "attachment"],
    ] as const) {
      const response = await createFileContentResponse({
        blobStorage,
        fileRef: { ...stored, fileName: "file", ...(mediaType === undefined ? {} : { mediaType }) },
      })
      const label = String(mediaType)
      expect(response?.headers.get("content-type"), label).toBe(contentType)
      expect(response?.headers.get("content-disposition"), label).toStartWith(`${disposition};`)
      expect(response?.headers.get("content-security-policy"), label).toBe(SANDBOXED)
      expect(response?.headers.get("x-content-type-options"), label).toBe("nosniff")
    }
  })

  // Chrome's PDF viewer does not render in a sandboxed page.
  test("keeps PDFs out of the sandbox while still blocking script", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const stored = await blobStorage.put({ body: new TextEncoder().encode("%PDF test") })

    const response = await createFileContentResponse({
      blobStorage,
      fileRef: { ...stored, mediaType: "Application/PDF" },
    })

    expect(response?.headers.get("content-type")).toBe("application/pdf")
    expect(response?.headers.get("content-disposition")).toStartWith("inline;")
    expect(response?.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; object-src 'self'"
    )
  })
})
