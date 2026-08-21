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

  test("derives coded error statuses from identity instead of message wording", () => {
    const set: { status?: number | string } = {}
    const response = handleRouteError(
      createSixbError("dataset.not_found", "No dataset matches this request"),
      set
    )

    expect(set.status).toBe(404)
    expect(response).toEqual({
      error: "No dataset matches this request",
      code: "dataset.not_found",
    })
  })

  test("maps shared access codes without depending on their message", () => {
    const cases = [
      ["share.access_unavailable", 401],
      ["share.grant_not_found", 404],
      ["share.type_not_found", 404],
    ] as const

    for (const [code, status] of cases) {
      const set: { status?: number | string } = {}

      expect(handleRouteError(createSixbError(code, "Safe message"), set)).toEqual({
        error: "Safe message",
        code,
      })
      expect(set.status).toBe(status)
    }
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
      code: "internal.unexpected",
    })
    expect(set.status).toBe(500)
  })
})
