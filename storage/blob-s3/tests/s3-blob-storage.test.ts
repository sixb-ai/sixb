import { describe, expect, test } from "bun:test"
import {
  normalizeS3BlobBasePath,
  s3BlobHexFromBlobId,
  s3BlobKeyForHex,
} from "../src/s3-blob-storage"

describe("S3 blob storage internals", () => {
  test("normalizes base paths", () => {
    expect(normalizeS3BlobBasePath("sixb")).toBe("sixb")
    expect(normalizeS3BlobBasePath("/company-lake/sixb/")).toBe("company-lake/sixb")
    expect(normalizeS3BlobBasePath(" company-lake / sixb ")).toBe("company-lake/sixb")
    expect(normalizeS3BlobBasePath("")).toBe("")
    expect(normalizeS3BlobBasePath("///")).toBe("")
  })

  test("builds blob keys under the configured base path", () => {
    const hex = "a".repeat(64)

    expect(s3BlobKeyForHex("sixb", hex)).toBe(`sixb/blobs/sha256/${hex}`)
    expect(s3BlobKeyForHex("company-lake/sixb", hex)).toBe(`company-lake/sixb/blobs/sha256/${hex}`)
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
