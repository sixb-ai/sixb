import { describe, expect, test } from "bun:test"
import { buildNetworkFlags, DOCKER_HUB_REGISTRY_HOSTS, withRegistryEgress } from "../src/network"

describe("buildNetworkFlags", () => {
  test("none -> no flags", () => {
    expect(buildNetworkFlags({ mode: "none" })).toEqual([])
  })

  test("all -> --net only", () => {
    expect(buildNetworkFlags({ mode: "all" })).toEqual(["--net"])
  })

  test("restricted -> --net plus one --allow-host per origin (hostname only)", () => {
    const flags = buildNetworkFlags({
      mode: "restricted",
      allow: [
        { name: "sixb-api", origin: "http://localhost:3002" },
        { name: "registry", origin: "https://registry.npmjs.org" },
      ],
    })
    expect(flags).toEqual([
      "--net",
      "--allow-host",
      "localhost",
      "--allow-host",
      "registry.npmjs.org",
    ])
  })

  test("restricted with no allow entries -> --net only", () => {
    expect(buildNetworkFlags({ mode: "restricted", allow: [] })).toEqual(["--net"])
  })

  test("falls back to the raw origin string when it is not a valid URL", () => {
    const flags = buildNetworkFlags({
      mode: "restricted",
      allow: [{ name: "bad", origin: "not a url" }],
    })
    expect(flags).toEqual(["--net", "--allow-host", "not a url"])
  })
})

describe("withRegistryEgress", () => {
  test("appends registry hosts to a restricted allow list (gateway preserved)", () => {
    const policy = withRegistryEgress(
      { mode: "restricted", allow: [{ name: "sixb-api", origin: "http://localhost:3002" }] },
      DOCKER_HUB_REGISTRY_HOSTS
    )
    const flags = buildNetworkFlags(policy)
    expect(flags).toContain("--allow-host")
    expect(flags).toContain("localhost") // gateway still allowed
    expect(flags).toContain("index.docker.io")
    expect(flags).toContain("registry-1.docker.io")
    expect(flags).toContain("auth.docker.io")
    expect(flags).toContain("production.cloudfront.docker.com")
  })

  test("leaves 'all' and 'none' policies untouched", () => {
    expect(withRegistryEgress({ mode: "all" }, DOCKER_HUB_REGISTRY_HOSTS)).toEqual({ mode: "all" })
    expect(withRegistryEgress({ mode: "none" }, DOCKER_HUB_REGISTRY_HOSTS)).toEqual({
      mode: "none",
    })
  })

  test("is a no-op when no hosts are given", () => {
    const policy = { mode: "restricted", allow: [] } as const
    expect(withRegistryEgress(policy, [])).toEqual(policy)
  })
})
