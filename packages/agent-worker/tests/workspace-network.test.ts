import { describe, expect, test } from "bun:test"
import type { SandboxNetworkPolicy } from "@sixb/core/sandboxes"
import { workspaceNetwork } from "../src/workspace-network"

const api = "https://api.example.com"
const repository = "https://github.com"
const baseline = {
  mode: "restricted" as const,
  allow: [
    { name: "sixb-api", origin: api },
    { name: "workspace-repository", origin: repository },
  ],
}

describe("workspace network", () => {
  test("derives minimal access only when the policy is omitted", () => {
    expect(workspaceNetwork(undefined, api, repository)).toEqual(baseline)
    expect(workspaceNetwork(undefined, api)).toEqual({
      mode: "restricted",
      allow: [baseline.allow[0]],
    })
    expect(workspaceNetwork(undefined, api, api)).toEqual({
      mode: "restricted",
      allow: [baseline.allow[0]],
    })
  })

  test.each<SandboxNetworkPolicy>([
    { mode: "none" },
    { mode: "restricted", allow: [] },
    { mode: "restricted", allow: [baseline.allow[0]!] },
    { mode: "restricted", allow: [baseline.allow[1]!] },
  ])("never widens an explicit policy: %j", (policy) => {
    // Regression proof: restore automatic API/repository additions; these policies stop failing.
    expect(() => workspaceNetwork(policy, api, repository)).toThrow("denies required")
  })

  test("keeps explicit policies unchanged", () => {
    expect(workspaceNetwork(baseline, api, repository)).toBe(baseline)
    expect(workspaceNetwork({ mode: "all" }, api, repository)).toEqual({ mode: "all" })
  })

  test("requires repository access for initial clone, not for an existing checkout", () => {
    const policy = { mode: "restricted" as const, allow: [baseline.allow[0]!] }
    expect(workspaceNetwork(policy, api, repository, false)).toBe(policy)
    expect(() => workspaceNetwork(policy, api, repository, true)).toThrow("workspace-repository")
  })
})
