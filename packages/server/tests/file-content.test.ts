import { describe, expect, test } from "bun:test"
import type { FileRef } from "@sixb/core"
import { resolveFileRefAtPath } from "../src/files/content"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 12,
  fileName: "test.pdf",
  mediaType: "application/pdf",
}

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
})
