import { describe, expect, test } from "bun:test"
import { resolveAppleContainerNetwork, warnIfRestrictedDowngraded } from "../src/network"

describe("Apple Container network policy mapping", () => {
  test('mode="none" creates a per-sandbox internal network', () => {
    expect(
      resolveAppleContainerNetwork({
        id: "run-1",
        policy: { mode: "none" },
        defaultNetworkName: "default",
        internalNetworkPrefix: "sixb-net-",
      })
    ).toEqual({
      createArgs: ["--network", "sixb-net-run-1"],
      ownedNetworkName: "sixb-net-run-1",
    })
  })

  test('mode="all" attaches the configured default network', () => {
    expect(
      resolveAppleContainerNetwork({
        id: "run-1",
        policy: { mode: "all" },
        defaultNetworkName: "public",
        internalNetworkPrefix: "sixb-net-",
      })
    ).toEqual({ createArgs: ["--network", "public"] })
  })

  test('mode="restricted" degrades to the configured default network', () => {
    expect(
      resolveAppleContainerNetwork({
        id: "run-1",
        policy: {
          mode: "restricted",
          allow: [{ name: "sixb-api", origin: "https://sixb.example" }],
        },
        defaultNetworkName: "default",
        internalNetworkPrefix: "sixb-net-",
      })
    ).toEqual({ createArgs: ["--network", "default"] })
  })

  test("restricted downgrade warns loudly", () => {
    const previous = console.warn
    const messages: string[] = []
    console.warn = (message?: unknown) => {
      messages.push(String(message))
    }
    try {
      warnIfRestrictedDowngraded({
        mode: "restricted",
        allow: [{ name: "sixb-api", origin: "https://sixb.example" }],
      })
    } finally {
      console.warn = previous
    }
    expect(messages[0]).toContain("cannot enforce per-origin restricted egress")
  })

  test("unsafe container or network names are rejected before reaching the CLI", () => {
    expect(() =>
      resolveAppleContainerNetwork({
        id: "../bad",
        policy: { mode: "none" },
        defaultNetworkName: "default",
        internalNetworkPrefix: "sixb-net-",
      })
    ).toThrow(TypeError)
  })
})
