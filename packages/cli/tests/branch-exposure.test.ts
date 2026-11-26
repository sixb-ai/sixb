import { afterEach, describe, expect, test } from "bun:test"
import { exposedBeyondThisMachine, resolveBrowserTopology } from "../src/lib/browser-topology"

// `sixb dev --from production` runs every request as the person who copied the branch: it starts
// only when nothing it binds or announces reaches beyond this machine.

const PUBLIC_ORIGINS = ["SIXB_API_PUBLIC_ORIGIN", "SIXB_APP_PUBLIC_ORIGIN"] as const
const saved = Object.fromEntries(PUBLIC_ORIGINS.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of PUBLIC_ORIGINS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const exposed = (
  flags: Parameters<typeof resolveBrowserTopology>[0] extends infer T ? Partial<T> : never
) => exposedBeyondThisMachine(resolveBrowserTopology({ role: "dev", ...flags }))

describe("a branch from production", () => {
  // Red check: in browser-topology.ts `namesThisMachine`, accept any host: `sixb dev --from
  // production --host 0.0.0.0` starts, and serves the person's data to the network.
  test("listens on this machine only", () => {
    for (const name of PUBLIC_ORIGINS) delete process.env[name]

    expect(exposed({})).toEqual([])
    expect(
      exposed({ host: "app.localhost", apiPublicOrigin: "http://api.localhost:3001" })
    ).toEqual([])
    expect(exposed({ host: "0.0.0.0" })).toEqual(["0.0.0.0", "0.0.0.0"])
    expect(exposed({ apiHost: "192.168.1.20" })).toEqual(["192.168.1.20"])
  })

  // Red check: in browser-topology.ts `exposedBeyondThisMachine`, check the bind addresses alone,
  // as the runner once checked the flags: an origin the environment sets slips through.
  test("announces no origin beyond this machine, from a flag or the environment", () => {
    for (const name of PUBLIC_ORIGINS) delete process.env[name]
    expect(exposed({ appPublicOrigin: "https://branch.example.com" })).toEqual([
      "https://branch.example.com",
    ])

    process.env.SIXB_API_PUBLIC_ORIGIN = "https://api.example.com"
    expect(exposed({})).toEqual(["https://api.example.com"])
  })
})
