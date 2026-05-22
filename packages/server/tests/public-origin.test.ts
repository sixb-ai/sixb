import { describe, expect, test } from "bun:test"
import { normalizePublicOrigin } from "../src/surfaces/publicOrigin"

describe("server public origin", () => {
  test("accepts http and https origins", () => {
    expect(normalizePublicOrigin("https://app.example.com")).toBe("https://app.example.com")
    expect(normalizePublicOrigin("http://localhost:3001")).toBe("http://localhost:3001")
  })

  test("rejects misleading non-origin values", () => {
    for (const value of [
      "ftp://app.example.com",
      "https://user@app.example.com",
      "https://app.example.com/auth",
      "https://app.example.com?next=/auth",
      "https://app.example.com#auth",
    ]) {
      expect(() => normalizePublicOrigin(value)).toThrow("[ParioServer]")
    }
  })
})
