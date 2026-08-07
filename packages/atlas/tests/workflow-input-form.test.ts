import { describe, expect, test } from "bun:test"
import type { FileRef } from "@sixb/core/blob-storage"
import { buildWorkflowInput } from "../src/features/workflows/components/WorkflowRunInputForm"

const fileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 123,
  fileName: "source.pdf",
  mediaType: "application/pdf",
} satisfies FileRef

describe("WorkflowRunInputForm", () => {
  test("builds exact decimal strings without Number coercion", () => {
    expect(
      buildWorkflowInput({ amount: "decimal" }, { amount: "+009007199254740993.0100" })
    ).toEqual({ input: { amount: "9007199254740993.01" }, errors: {} })

    expect(buildWorkflowInput({ amount: "decimal" }, { amount: "1e3" })).toEqual({
      input: {},
      errors: { amount: "amount must be an exact decimal." },
    })
  })

  test("validates fileRef inputs before building workflow input", () => {
    expect(
      buildWorkflowInput({ sourceFile: "fileRef" }, { sourceFile: JSON.stringify(fileRef) })
    ).toEqual({
      input: { sourceFile: fileRef },
      errors: {},
    })

    expect(buildWorkflowInput({ sourceFile: "fileRef" }, { sourceFile: "{}" })).toEqual({
      input: {},
      errors: { sourceFile: "sourceFile must be an uploaded file." },
    })
  })

  test("rejects JSON numbers that cannot be represented as finite values", () => {
    expect(buildWorkflowInput({ payload: "json" }, { payload: "1e400" })).toEqual({
      input: {},
      errors: { payload: "payload must be valid JSON." },
    })
  })
})
