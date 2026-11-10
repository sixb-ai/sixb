import { describe, expect, test } from "bun:test"
import type { FileRef } from "@sixb/core/blob-storage"
import {
  buildWorkflowInput,
  createInitialWorkflowInputFormValues,
} from "../src/pages/console/ontology/workflows/run-input-form"

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

  test("sends a user id as a user reference", () => {
    expect(buildWorkflowInput({ assignee: "userRef" }, { assignee: " usr_1 " })).toEqual({
      input: { assignee: { type: "user", id: "usr_1" } },
      errors: {},
    })
  })

  // Regression proof: drop the `artifactRef` branch from buildWorkflowInput and the id is sent as a
  // plain string, which the workflow's input refuses.
  test("sends an artifact id as an artifact reference, and fills the form back with the id", () => {
    const plan = { type: "artifact", id: "art_k3m9q2x7tp" }
    expect(buildWorkflowInput({ plan: "artifactRef" }, { plan: " art_k3m9q2x7tp " })).toEqual({
      input: { plan },
      errors: {},
    })
    expect(createInitialWorkflowInputFormValues({ plan: "artifactRef" }, { plan })).toEqual({
      plan: "art_k3m9q2x7tp",
    })
  })

  test("rejects JSON numbers that cannot be represented as finite values", () => {
    expect(buildWorkflowInput({ payload: "json" }, { payload: "1e400" })).toEqual({
      input: {},
      errors: { payload: "payload must be valid JSON." },
    })
  })
})
