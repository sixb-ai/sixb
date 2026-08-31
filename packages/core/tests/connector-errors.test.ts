import { describe, expect, test } from "bun:test"
import { createConnectorCodedError, providerBoundaryError } from "../src/connectors/errors"
import { createSixbError, isSixbError } from "../src/errors/internal"

describe("connector provider error boundary", () => {
  test("preserves connector failures produced by nested connector operations", () => {
    const connectorError = createConnectorCodedError(
      "connector.authorization_required",
      "Connector authorization is required."
    )

    expect(
      providerBoundaryError(
        connectorError,
        "connector.provider_failed",
        "Connector provider operation failed."
      )
    ).toBe(connectorError)
  })

  test("wraps coded failures from another domain", () => {
    const foreignError = createSixbError("dataset.not_found", "[Sixb] Dataset was not found.")
    const error = providerBoundaryError(
      foreignError,
      "connector.provider_failed",
      "Connector provider operation failed."
    )

    expect(isSixbError(error)).toBe(true)
    if (!isSixbError(error)) throw new Error("Expected a coded Sixb error.")
    expect(error.code).toBe("connector.provider_failed")
    expect(error.cause).toBe(foreignError)
  })
})
