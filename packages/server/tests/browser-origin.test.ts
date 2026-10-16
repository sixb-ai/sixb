import { describe, expect, test } from "bun:test"
import { isAllowedApiBrowserOrigin, resolveApiBrowserPolicy } from "../src/auth/browser-origin"

function fromOrigin(origin: string): Request {
  return new Request("https://api.example.com/api/auth/session", { headers: { Origin: origin } })
}

describe("API browser policy", () => {
  // A deploy without the app (`services: { app: false }`) starts the API with no browser origin.
  // Regression proof: refuse an empty `allowedOrigins` in resolveApiBrowserPolicy and this throws.
  test("an API serving no app admits only its own origin", () => {
    const policy = resolveApiBrowserPolicy({
      publicOrigin: "https://api.example.com",
      allowedOrigins: [],
    })

    expect(isAllowedApiBrowserOrigin(policy, fromOrigin("https://api.example.com"))).toBe(true)
    expect(isAllowedApiBrowserOrigin(policy, fromOrigin("https://app.example.com"))).toBe(false)
  })
})
