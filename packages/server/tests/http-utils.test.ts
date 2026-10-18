import { describe, expect, test } from "bun:test"
import { createSixbError } from "@sixb/core/internal/errors"
import { codedErrorResponseSchema } from "../src/schemas/common"
import { handleRouteError } from "../src/utils/http"

describe("handleRouteError", () => {
  test("constrains coded response schemas to their declared codes", () => {
    const schema = codedErrorResponseSchema(["dataset.not_found"])

    expect(schema.parse({ error: "Missing", code: "dataset.not_found" })).toEqual({
      error: "Missing",
      code: "dataset.not_found",
    })
    expect(() =>
      schema.parse({ error: "Missing version", code: "dataset.version_not_found" })
    ).toThrow()
  })

  test.each([
    ["dataset.not_found", "No dataset matches this request", 404],
    // An uncategorized coded exception is an internal failure.
    ["internal.unexpected", "Commit failed", 500],
  ] as const)("derives the status of %s from its code, not its wording", (code, message, status) => {
    const set: { status?: number | string } = {}

    expect(handleRouteError(createSixbError(code, message), set)).toEqual({ error: message, code })
    expect(set.status).toBe(status)
  })

  test("exposes structured details only for declared AI limit errors", () => {
    const hidden = handleRouteError(
      createSixbError("dataset.not_found", "Missing", { details: { datasetId: "private" } }),
      {}
    )
    const exposed = handleRouteError(
      createSixbError("ai.usage_limit_unavailable", "Unavailable", {
        details: { reasons: ["missingEstimate"] },
      }),
      {}
    )

    expect(hidden).toEqual({ error: "Missing", code: "dataset.not_found" })
    expect(exposed).toEqual({
      error: "Unavailable",
      code: "ai.usage_limit_unavailable",
      details: { reasons: ["missingEstimate"] },
    })
  })

  test("does not infer a status from legacy error messages", () => {
    for (const message of ["Unknown property", "Resource not found"]) {
      const set: { status?: number | string } = {}

      expect(handleRouteError(new Error(message), set)).toEqual({ error: message })
      expect(set.status).toBe(400)
    }
  })
})
