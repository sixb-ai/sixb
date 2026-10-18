import { describe, expect, test } from "bun:test"
import { computeBlobDigest } from "@sixb/core/blob-storage/server"
import { computeStreamingBlobDigest } from "../src/sha256"

describe("computeStreamingBlobDigest", () => {
  test("matches the FIPS 180-4 vector and core computeBlobDigest across chunk boundaries", async () => {
    expect(await computeStreamingBlobDigest(new Blob(["abc"]))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
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
