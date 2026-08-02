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
      role: "dev",
      hasCustomApp: true,
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
      role: "dev",
      hasCustomApp: false,
    })

    expect(topology.appPublicOrigin).toBeNull()
    expect(topology.allowedBrowserOrigins).toEqual([
      { origin: "http://localhost:3000", audience: "atlas" },
    ])
  })

  test("binds every interface in production", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_ATLAS_PUBLIC_ORIGIN = "https://atlas.example.com"

    const topology = resolveBrowserTopology({ role: "api", hasCustomApp: false })

    // The opposite default from development, and deliberately so: a role in a container
    // has to accept traffic from its load balancer, which is never on loopback.
    expect(topology).toMatchObject({ host: "0.0.0.0", apiHost: "0.0.0.0" })
  })

  test("requires explicit production origins", () => {
    expect(() =>
      resolveBrowserTopology({
        role: "api",
        hasCustomApp: true,
      })
    ).toThrow("SIXB_API_PUBLIC_ORIGIN")
  })

  test("uses configured production origins and bind ports", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_ATLAS_PUBLIC_ORIGIN = "https://atlas.example.com"
    process.env.SIXB_APP_PUBLIC_ORIGIN = "https://app.example.com"

    const topology = resolveBrowserTopology({
      role: "api",
      host: "127.0.0.1",
      apiHost: "127.0.0.2",
      port: "8080",
      apiPort: "8082",
      hasCustomApp: true,
    })

    // The API role binds one port. It resolves the other surfaces' *origins*, because they are
    // its CORS allowlist, but never their ports — so those are not asserted here.
    expect(topology).toMatchObject({
      host: "127.0.0.1",
      apiHost: "127.0.0.2",
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
    expect(() => resolveBrowserTopology({ role: "api", hasCustomApp: false })).toThrow(
      "SIXB_ATLAS_PUBLIC_ORIGIN"
    )
  })

  test("serves a surface without its own public origin, and prints where it bound", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"

    const topology = resolveBrowserTopology({
      role: "atlas",
      host: "127.0.0.1",
      port: "8080",
    })

    // Atlas passes its own origin to nothing but the startup panel, so demanding one only
    // bought an operator a crash on their first production command.
    expect(topology.atlasPublicOrigin).toBeNull()
    expect(servedUrl(topology)).toBe("http://127.0.0.1:8080")
  })

  test("prints a reachable address when the role bound every interface", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"

    const topology = resolveBrowserTopology({ role: "atlas" })

    // The production default is `0.0.0.0`, which is where the socket listens and not
    // somewhere a browser can go. Answering "where do I go?" with it is a URL an
    // operator has to translate before it is worth printing.
    expect(topology.host).toBe("0.0.0.0")
    expect(servedUrl(topology)).toBe("http://localhost:3000")
  })

  test("prefers a configured origin over the bound address", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_ATLAS_PUBLIC_ORIGIN = "https://atlas.example.com"

    const topology = resolveBrowserTopology({ role: "atlas" })

    expect(servedUrl(topology)).toBe("https://atlas.example.com")
  })

  test("keeps the API origin required on the role that only displays a surface", () => {
    // `sixb atlas` ships a bundle that calls the API. Guessing that address serves a UI
    // that cannot talk to anything, which is worse than not starting.
    expect(() => resolveBrowserTopology({ role: "atlas" })).toThrow("SIXB_API_PUBLIC_ORIGIN")
  })

  test("gives --port to the surface the role actually binds", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_ATLAS_PUBLIC_ORIGIN = "https://atlas.example.com"

    // `--port` used to name Atlas's port whatever the role was, and each command translated it
    // on the way in. Only `sixb app` translated to a different field, so writing it the way its
    // three neighbours do bound the app one port past where the operator asked.
    //
    // To see this fail, drop the role checks in `resolveBrowserPorts` — `appPort: base +
    // DEFAULT_APP_PORT_OFFSET` alone puts the app on 4001 and the API back on 3002.
    expect(resolveBrowserTopology({ role: "app", port: "4000" }).appPort).toBe(4000)
    expect(resolveBrowserTopology({ role: "atlas", port: "4000" }).atlasPort).toBe(4000)
    expect(resolveBrowserTopology({ role: "api", hasCustomApp: false, port: "4000" }).apiPort).toBe(
      4000
    )
  })

  test("keeps the offsets a role that binds every surface depends on", () => {
    const dev = resolveBrowserTopology({ role: "dev", hasCustomApp: true, port: "8080" })

    // `sixb dev` is the one role that binds all three, so its `--port` still moves the block.
    expect(dev).toMatchObject({ atlasPort: 8080, appPort: 8081, apiPort: 8082 })
  })

  test("leaves each single-surface role on its usual port with no flag", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_ATLAS_PUBLIC_ORIGIN = "https://atlas.example.com"

    // Unflagged, a role lands where `sixb dev` would have put it — the addresses the README and
    // the deployment page print. Making `--port` mean "mine" must not move these.
    expect(resolveBrowserTopology({ role: "atlas" }).atlasPort).toBe(3000)
    expect(resolveBrowserTopology({ role: "app" }).appPort).toBe(3001)
    expect(resolveBrowserTopology({ role: "api", hasCustomApp: false }).apiPort).toBe(3002)
  })

  test("lets --api-port win over --port on the role that takes both", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    process.env.SIXB_ATLAS_PUBLIC_ORIGIN = "https://atlas.example.com"

    const topology = resolveBrowserTopology({
      role: "api",
      hasCustomApp: false,
      port: "8080",
      apiPort: "9000",
    })

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
      resolveBrowserTopology({
        role: "dev",
        hasCustomApp: false,
        apiPublicOrigin: "https://api.example.com/api",
      })
    ).toThrow("must be an origin")
  })
})
