import { describe, expect, test } from "bun:test"
import { computeBlobDigest } from "@sixb/core/blob-storage/server"
import { computeStreamingBlobDigest } from "../src/sha256"

describe("computeStreamingBlobDigest", () => {
  test("matches the FIPS 180-4 known-answer vectors", async () => {
    expect(await computeStreamingBlobDigest(new Blob([""]))).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
    expect(await computeStreamingBlobDigest(new Blob(["abc"]))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  test("matches core computeBlobDigest across sizes and chunk boundaries", async () => {
    // The sizes bracket the 55/56 padding boundary, the 64-byte block boundary,
    // and multi-block inputs; the tiny chunk size forces multi-slice streaming.
    for (const size of [0, 1, 55, 56, 63, 64, 65, 128, 1000, 200_000]) {
      const bytes = new Uint8Array(size)
      for (let i = 0; i < size; i++) {
        bytes[i] = (i * 31 + 7) % 256
      }
      const expected = computeBlobDigest(bytes)
      expect(await computeStreamingBlobDigest(new Blob([bytes]), 100)).toBe(expected)
    }
  })
})
