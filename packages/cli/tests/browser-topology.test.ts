import { afterEach, describe, expect, test } from "bun:test"
import {
  apiDocsUrl,
  apiEventsUrl,
  apiUrl,
  resolveBrowserTopology,
  servedUrl,
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
      // Loopback, not every interface. A dev server binding 0.0.0.0 put the project's
      // data — behind an API usually running with auth disabled — on whatever network
      // the laptop was on. The origins stay `localhost`, so nothing an author reads
      // changes; `--host 0.0.0.0` opts back in for reaching it from a phone.
      host: "127.0.0.1",
      apiHost: "127.0.0.1",
      atlasPort: 3000,
      appPort: 3001,
      apiPort: 3002,
      atlasPublicOrigin: "http://localhost:3000",
      appPublicOrigin: "http://localhost:3001",
      apiPublicOrigin: "http://localhost:3002",
    })
    expect(topology.allowedBrowserOrigins).toEqual([
      { origin: "http://localhost:3000", audience: "atlas" },
      { origin: "http://localhost:3001", audience: "app" },
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
      { origin: "http://localhost:3000", audience: "atlas" },
    ])
  })

  test("binds every interface in production", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_ATLAS_PUBLIC_ORIGIN = "https://atlas.example.com"

    const topology = resolveBrowserTopology({ mode: "production", includeCustomApp: false })

    // The opposite default from development, and deliberately so: a role in a container
    // has to accept traffic from its load balancer, which is never on loopback.
    expect(topology).toMatchObject({ host: "0.0.0.0", apiHost: "0.0.0.0" })
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
      { origin: "https://atlas.example.com", audience: "atlas" },
      { origin: "https://app.example.com", audience: "app" },
    ])
    expect(apiEventsUrl(topology)).toBe("wss://api.example.com/ws/events")
  })

  test("still requires the origin a surface's own role does not serve", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"

    // The API role serves neither surface: these origins are its CORS allowlist, and an
    // allowlist assembled from guesses is a hole. It is the one role that must refuse.
    expect(() => resolveBrowserTopology({ mode: "production", includeCustomApp: false })).toThrow(
      "SIXB_ATLAS_PUBLIC_ORIGIN"
    )
  })

  test("serves a surface without its own public origin, and prints where it bound", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"

    const topology = resolveBrowserTopology({
      mode: "production",
      host: "127.0.0.1",
      port: "8080",
      includeCustomApp: false,
      serves: "atlas",
    })

    // Atlas passes its own origin to nothing but the startup panel, so demanding one only
    // bought an operator a crash on their first production command.
    expect(topology.atlasPublicOrigin).toBeNull()
    expect(servedUrl(topology, "atlas")).toBe("http://127.0.0.1:8080")
  })

  test("prefers a configured origin over the bound address", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_ATLAS_PUBLIC_ORIGIN = "https://atlas.example.com"

    const topology = resolveBrowserTopology({
      mode: "production",
      includeCustomApp: false,
      serves: "atlas",
    })

    expect(servedUrl(topology, "atlas")).toBe("https://atlas.example.com")
  })

  test("keeps the API origin required on the role that only displays a surface", () => {
    // `sixb atlas` ships a bundle that calls the API. Guessing that address serves a UI
    // that cannot talk to anything, which is worse than not starting.
    expect(() =>
      resolveBrowserTopology({ mode: "production", includeCustomApp: false, serves: "atlas" })
    ).toThrow("SIXB_API_PUBLIC_ORIGIN")
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
