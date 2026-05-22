import { describe, expect, test } from "bun:test"
import {
  normalizeS3BlobBasePath,
  s3BlobHexFromBlobId,
  s3BlobKeyForHex,
} from "../src/s3-blob-storage"

describe("S3 blob storage internals", () => {
  test("normalizes base paths", () => {
    expect(normalizeS3BlobBasePath("pario")).toBe("pario")
    expect(normalizeS3BlobBasePath("/company-lake/pario/")).toBe("company-lake/pario")
    expect(normalizeS3BlobBasePath(" company-lake / pario ")).toBe("company-lake/pario")
    expect(normalizeS3BlobBasePath("")).toBe("")
    expect(normalizeS3BlobBasePath("///")).toBe("")
  })

  test("builds blob keys under the configured base path", () => {
    const hex = "a".repeat(64)

    expect(s3BlobKeyForHex("pario", hex)).toBe(`pario/blobs/sha256/${hex}`)
    expect(s3BlobKeyForHex("company-lake/pario", hex)).toBe(
      `company-lake/pario/blobs/sha256/${hex}`
    )
    expect(s3BlobKeyForHex("", hex)).toBe(`blobs/sha256/${hex}`)
  })

  test("extracts sha256 hex from supported blob ids", () => {
    const hex = "b".repeat(64)

    expect(s3BlobHexFromBlobId(`blob_${hex}`)).toBe(hex)
    expect(s3BlobHexFromBlobId("blob_missing")).toBeNull()
    expect(s3BlobHexFromBlobId(`blob_${"g".repeat(64)}`)).toBeNull()
    expect(s3BlobHexFromBlobId(`Blob_${hex}`)).toBeNull()
  })
})
