import { describe, expect, test } from "bun:test"
import type { ListActionsResponse, ObjectAction } from "@sixb/client"
import type { FileRef } from "@sixb/core/blob-storage"
import {
  actionNeedsParamDialog,
  buildActionParams,
  buildObjectActionParams,
  describeActionParamInput,
} from "../src/lib/actions/params"

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
  test("preserves omitted, null, and concrete catalog values", () => {
    const optional = actionWithParam({
      id: "category",
      name: "Category",
      schema: { type: "enum", valueType: "string", values: ["general_services"] },
      nullable: true,
    })
    const required = actionWithParam({
      id: "category",
      name: "Category",
      schema: "string",
      required: true,
      nullable: true,
    })

    expect(buildActionParams(optional, {})).toEqual({ params: {}, errors: {} })
    expect(buildActionParams(optional, { category: null })).toEqual({
      params: { category: null },
      errors: {},
    })
    expect(buildActionParams(optional, { category: "general_services" })).toEqual({
      params: { category: "general_services" },
      errors: {},
    })
    expect(buildActionParams(required, { category: "" }).errors).toEqual({
      category: "Required.",
    })
    expect(buildActionParams(required, { category: null })).toEqual({
      params: { category: null },
      errors: {},
    })
    expect(
      buildActionParams(actionWithParam({ id: "category", name: "Category", schema: "string" }), {
        category: null,
      }).errors
    ).toEqual({ category: "This parameter cannot be null." })
  })

  test("preserves tri-state values for object action forms", () => {
    const action: ObjectAction = {
      id: "updateCategory",
      params: {
        category: { type: "string", nullable: true },
      },
    }

    expect(buildObjectActionParams(action, {})).toEqual({ params: {}, errors: {} })
    expect(buildObjectActionParams(action, { category: null })).toEqual({
      params: { category: null },
      errors: {},
    })
    expect(buildObjectActionParams(action, { category: "general_services" })).toEqual({
      params: { category: "general_services" },
      errors: {},
    })
    expect(actionNeedsParamDialog(action)).toBe(true)
    expect(
      actionNeedsParamDialog({ id: "optionalOnly", params: { note: { type: "string" } } })
    ).toBe(false)
  })

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
