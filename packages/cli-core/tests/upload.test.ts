import { expect, test } from "bun:test"
import { DEFAULT_SIMPLE_FILE_UPLOAD_BYTES } from "@sixb/core/blob-storage"
import { SIMPLE_UPLOAD_MAX_BYTES } from "../src/upload"

// To check, change either constant: a file between the two goes the wrong way, and the API
// refuses it in one request or never sees it there.
test("sends in one request exactly what the API's simple upload takes", () => {
  expect(SIMPLE_UPLOAD_MAX_BYTES).toBe(DEFAULT_SIMPLE_FILE_UPLOAD_BYTES)
})
