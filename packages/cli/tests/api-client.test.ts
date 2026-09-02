import { describe, expect, test } from "bun:test"
import { normalizeApiUrl } from "../src/lib/api-client"

describe("CLI API client config", () => {
  test("normalizes API origins with or without /api", () => {
    expect(normalizeApiUrl("http://localhost:3002")).toBe("http://localhost:3002")
    expect(normalizeApiUrl("http://localhost:3002/api")).toBe("http://localhost:3002")
  })
})
