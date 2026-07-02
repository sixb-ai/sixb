import { describe, expect, test } from "bun:test"
import type { ListActionsResponse } from "@sixb/client"
import type { FileRef } from "@sixb/core/blob-storage"
import { buildActionParams, describeActionParamInput } from "../src/lib/actions/params"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 123,
  fileName: "source.pdf",
  mediaType: "application/pdf",
}

function actionWithParam(param: ListActionsResponse[number]["params"][number]) {
  return {
    id: "extract",
    name: "Extract",
    params: [param],
    phases: { validate: true, writeback: false, edits: true, effects: false },
  } satisfies ListActionsResponse[number]
}

describe("Atlas action params", () => {
  test("recognizes fileRef params and parses uploaded FileRefs", () => {
    const action = actionWithParam({
      id: "sourcePdf",
      name: "Source PDF",
      schema: "fileRef",
      required: true,
    })

    expect(describeActionParamInput("fileRef")).toEqual({ kind: "fileRef" })
    expect(buildActionParams(action, { sourcePdf: JSON.stringify(fileRef) })).toEqual({
      params: { sourcePdf: fileRef },
      errors: {},
    })
    expect(buildActionParams(action, { sourcePdf: "{}" }).errors).toEqual({
      sourcePdf: "Expected an uploaded file.",
    })
  })
})
