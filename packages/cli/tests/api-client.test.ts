import { describe, expect, test } from "bun:test"
import { normalizeApiUrl, resolveApiClientConfig } from "../src/lib/api-client"

describe("CLI API client config", () => {
  test("resolves API URL and token precedence", () => {
    const config = resolveApiClientConfig({
      apiUrl: "http://flag.localhost:3002/api",
      token: "flag-token",
      env: {
        SIXB_API_URL: "http://env.localhost:3002",
        SIXB_API_TOKEN: "env-token",
      },
    })

    expect(config.apiUrl).toBe("http://flag.localhost:3002")
    expect(config.apiUrlSource).toBe("--api-url")
    expect(config.token).toBe("flag-token")
    expect(config.tokenSource).toBe("--token")
  })

  test("falls back to env API URL and token", () => {
    const config = resolveApiClientConfig({
      env: {
        SIXB_API_URL: "http://localhost:3001/api",
        SIXB_API_TOKEN: "env-token",
      },
    })

    expect(config.apiUrl).toBe("http://localhost:3001")
    expect(config.apiUrlSource).toBe("SIXB_API_URL")
    expect(config.token).toBe("env-token")
    expect(config.tokenSource).toBe("SIXB_API_TOKEN")
  })

  test("normalizes API origins with or without /api", () => {
    expect(normalizeApiUrl("http://localhost:3002")).toBe("http://localhost:3002")
    expect(normalizeApiUrl("http://localhost:3002/api")).toBe("http://localhost:3002")
  })
})
