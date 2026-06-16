import { afterEach, describe, expect, test } from "bun:test"
import {
  apiDocsUrl,
  apiEventsUrl,
  apiUrl,
  resolveBrowserTopology,
} from "../src/lib/browser-topology"

const PUBLIC_ORIGIN_ENV = [
  "SIXB_API_PUBLIC_ORIGIN",
  "SIXB_ATLAS_PUBLIC_ORIGIN",
  "SIXB_APP_PUBLIC_ORIGIN",
] as const
const originalEnv = Object.fromEntries(PUBLIC_ORIGIN_ENV.map((name) => [name, process.env[name]]))

describe("browser topology", () => {
  afterEach(() => {
    for (const name of PUBLIC_ORIGIN_ENV) {
      const originalValue = originalEnv[name]
      if (originalValue === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = originalValue
      }
    }
  })

  test("derives localhost origins on separate ports for development", () => {
    const topology = resolveBrowserTopology({
      mode: "development",
      includeCustomApp: true,
    })

    expect(topology).toMatchObject({
      host: "0.0.0.0",
      apiHost: "0.0.0.0",
      atlasPort: 3000,
      appPort: 3001,
      apiPort: 3002,
      atlasPublicOrigin: "http://localhost:3000",
      appPublicOrigin: "http://localhost:3001",
      apiPublicOrigin: "http://localhost:3002",
    })
    expect(topology.allowedBrowserOrigins).toEqual([
      { origin: "http://localhost:3000", audience: "atlas", kind: "atlas" },
      { origin: "http://localhost:3001", audience: "app", kind: "app" },
    ])
    expect(apiUrl(topology)).toBe("http://localhost:3002/api")
    expect(apiDocsUrl(topology)).toBe("http://localhost:3002/docs")
    expect(apiEventsUrl(topology)).toBe("ws://localhost:3002/ws/events")
  })

  test("omits the app origin when no custom app is served", () => {
    const topology = resolveBrowserTopology({
      mode: "development",
      includeCustomApp: false,
    })

    expect(topology.appPublicOrigin).toBeNull()
    expect(topology.allowedBrowserOrigins).toEqual([
      { origin: "http://localhost:3000", audience: "atlas", kind: "atlas" },
    ])
  })

  test("requires explicit production origins", () => {
    expect(() =>
      resolveBrowserTopology({
        mode: "production",
        includeCustomApp: true,
      })
    ).toThrow("SIXB_API_PUBLIC_ORIGIN")
  })

  test("uses configured production origins and bind ports", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_ATLAS_PUBLIC_ORIGIN = "https://atlas.example.com"
    process.env.SIXB_APP_PUBLIC_ORIGIN = "https://app.example.com"

    const topology = resolveBrowserTopology({
      mode: "production",
      host: "127.0.0.1",
      apiHost: "127.0.0.2",
      port: "8080",
      apiPort: "8082",
      includeCustomApp: true,
    })

    expect(topology).toMatchObject({
      host: "127.0.0.1",
      apiHost: "127.0.0.2",
      atlasPort: 8080,
      appPort: 8081,
      apiPort: 8082,
      atlasPublicOrigin: "https://atlas.example.com",
      appPublicOrigin: "https://app.example.com",
      apiPublicOrigin: "https://api.example.com",
    })
    expect(topology.allowedBrowserOrigins).toEqual([
      { origin: "https://atlas.example.com", audience: "atlas", kind: "atlas" },
      { origin: "https://app.example.com", audience: "app", kind: "app" },
    ])
    expect(apiEventsUrl(topology)).toBe("wss://api.example.com/ws/events")
  })

  test("rejects full URLs where public origins are expected", () => {
    expect(() =>
      resolveBrowserTopology({
        mode: "development",
        includeCustomApp: false,
        apiPublicOrigin: "https://api.example.com/api",
      })
    ).toThrow("must be an origin")
  })
})
