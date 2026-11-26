import { afterEach, describe, expect, test } from "bun:test"
import {
  apiDocsUrl,
  apiEventsUrl,
  apiUrl,
  resolveBrowserTopology,
  servedUrl,
} from "../src/lib/browser-topology"

const PUBLIC_ORIGIN_ENV = ["SIXB_API_PUBLIC_ORIGIN", "SIXB_APP_PUBLIC_ORIGIN"] as const
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
    const topology = resolveBrowserTopology({ role: "dev" })

    expect(topology).toMatchObject({
      // Loopback, not every interface. A dev server binding 0.0.0.0 put the project's
      // data — behind an API usually running with auth disabled — on whatever network
      // the laptop was on. The origins stay `localhost`, so nothing an author reads
      // changes; `--host 0.0.0.0` opts back in for reaching it from a phone.
      host: "127.0.0.1",
      apiHost: "127.0.0.1",
      appPort: 3000,
      apiPort: 3001,
      appPublicOrigin: "http://localhost:3000",
      apiPublicOrigin: "http://localhost:3001",
    })
    expect(topology.allowedBrowserOrigins).toEqual(["http://localhost:3000"])
    expect(apiUrl(topology)).toBe("http://localhost:3001/api")
    expect(apiDocsUrl(topology)).toBe("http://localhost:3001/docs")
    expect(apiEventsUrl(topology)).toBe("ws://localhost:3001/ws/events")
  })

  test("binds every interface in production", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_APP_PUBLIC_ORIGIN = "https://app.example.com"

    const topology = resolveBrowserTopology({ role: "api" })

    // The opposite default from development, and deliberately so: a role in a container
    // has to accept traffic from its load balancer, which is never on loopback.
    expect(topology).toMatchObject({ host: "0.0.0.0", apiHost: "0.0.0.0" })
  })

  test("requires explicit production origins", () => {
    expect(() => resolveBrowserTopology({ role: "api" })).toThrow("SIXB_API_PUBLIC_ORIGIN")
  })

  test("uses configured production origins and bind ports", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_APP_PUBLIC_ORIGIN = "https://app.example.com"

    const topology = resolveBrowserTopology({
      role: "api",
      host: "127.0.0.1",
      apiHost: "127.0.0.2",
      port: "8080",
      apiPort: "8082",
    })

    // The API role binds one port. It resolves the app's *origin*, because that is its CORS
    // allowlist, but never the app's port — so that is not asserted here.
    expect(topology).toMatchObject({
      host: "127.0.0.1",
      apiHost: "127.0.0.2",
      apiPort: 8082,
      appPublicOrigin: "https://app.example.com",
      apiPublicOrigin: "https://api.example.com",
    })
    expect(topology.allowedBrowserOrigins).toEqual(["https://app.example.com"])
    expect(apiEventsUrl(topology)).toBe("wss://api.example.com/ws/events")
  })

  // A deploy with `services: { app: false }` runs the API alone and never sets the app's origin.
  // Regression proof: make the API role refuse a missing SIXB_APP_PUBLIC_ORIGIN and this throws.
  test("starts the API without an app origin, admitting no browser origin", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"

    const topology = resolveBrowserTopology({ role: "api" })

    // An allowlist assembled from guesses is a hole, so nothing is inferred in its place.
    expect(topology.appPublicOrigin).toBeNull()
    expect(topology.allowedBrowserOrigins).toEqual([])
  })

  test("serves the app without its own public origin, and prints where it bound", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"

    const topology = resolveBrowserTopology({ role: "app", host: "127.0.0.1", port: "8080" })

    // The app passes its own origin to nothing but the startup panel, so demanding one only
    // bought an operator a crash on their first production command.
    expect(topology.appPublicOrigin).toBeNull()
    expect(servedUrl(topology)).toBe("http://127.0.0.1:8080")
  })

  test("prints a reachable address when the role bound every interface", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"

    const topology = resolveBrowserTopology({ role: "app" })

    // The production default is `0.0.0.0`, which is where the socket listens and not
    // somewhere a browser can go. Answering "where do I go?" with it is a URL an
    // operator has to translate before it is worth printing.
    expect(topology.host).toBe("0.0.0.0")
    expect(servedUrl(topology)).toBe("http://localhost:3000")
  })

  test("prefers a configured origin over the bound address", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_APP_PUBLIC_ORIGIN = "https://app.example.com"

    expect(servedUrl(resolveBrowserTopology({ role: "app" }))).toBe("https://app.example.com")
  })

  test("keeps the API origin required on the role that only serves the app", () => {
    // `sixb app` ships a bundle that calls the API. Guessing that address serves a UI
    // that cannot talk to anything, which is worse than not starting.
    expect(() => resolveBrowserTopology({ role: "app" })).toThrow("SIXB_API_PUBLIC_ORIGIN")
  })

  test("gives --port to the port the role actually binds", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_APP_PUBLIC_ORIGIN = "https://app.example.com"

    // `--port` used to name one fixed port whatever the role was, and each command translated
    // it on the way in. To see this fail, drop the role checks in `resolveBrowserPorts` — the
    // API then lands one port past where the operator asked.
    expect(resolveBrowserTopology({ role: "app", port: "4000" }).appPort).toBe(4000)
    expect(resolveBrowserTopology({ role: "api", port: "4000" }).apiPort).toBe(4000)
  })

  test("keeps the offset the role that binds both depends on", () => {
    const dev = resolveBrowserTopology({ role: "dev", port: "8080" })

    // `sixb dev` is the one role that binds the app and the API, so its `--port` moves both.
    expect(dev).toMatchObject({ appPort: 8080, apiPort: 8081 })
  })

  test("leaves each production role on its usual port with no flag", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_APP_PUBLIC_ORIGIN = "https://app.example.com"

    // Unflagged, a role lands where `sixb dev` would have put it — the addresses the README and
    // the deployment page print. Making `--port` mean "mine" must not move these.
    expect(resolveBrowserTopology({ role: "app" }).appPort).toBe(3000)
    expect(resolveBrowserTopology({ role: "api" }).apiPort).toBe(3001)
  })

  test("lets --api-port win over --port on the role that takes both", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_APP_PUBLIC_ORIGIN = "https://app.example.com"

    const topology = resolveBrowserTopology({ role: "api", port: "8080", apiPort: "9000" })

    expect(topology.apiPort).toBe(9000)
  })

  test("names the flag the operator typed when a port is invalid", () => {
    // The error said `--app-port`, a flag no command accepts, to anyone who mistyped
    // `sixb app --port`.
    expect(() => resolveBrowserTopology({ role: "app", port: "abc" })).toThrow(
      "--port must be a valid TCP port"
    )
  })

  test("rejects full URLs where public origins are expected", () => {
    expect(() =>
      resolveBrowserTopology({ role: "dev", apiPublicOrigin: "https://api.example.com/api" })
    ).toThrow("must be an origin")
  })
})
