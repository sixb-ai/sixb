import { describe, expect, test } from "bun:test"
import { createSixbError } from "@sixb/core/internal/errors"
import { handleRouteError } from "../src/utils/http"

describe("handleRouteError", () => {
  test("derives coded error statuses from identity instead of message wording", () => {
    const set: { status?: number | string } = {}
    const response = handleRouteError(
      createSixbError("dataset.not_found", "No dataset matches this request"),
      set
    )

    expect(set.status).toBe(404)
    expect(response).toEqual({ error: "No dataset matches this request" })
  })

  test("does not infer a status from legacy error messages", () => {
    for (const message of ["Unknown property", "Resource not found"]) {
      const set: { status?: number | string } = {}

      expect(handleRouteError(new Error(message), set)).toEqual({ error: message })
      expect(set.status).toBe(400)
    }
  })

  test("treats uncategorized coded exceptions as internal failures", () => {
    const set: { status?: number | string } = {}

    expect(handleRouteError(createSixbError("internal.unexpected", "Commit failed"), set)).toEqual({
      error: "Commit failed",
    })
    expect(set.status).toBe(500)
  })
})
