import { describe, expect, test } from "bun:test"
import type { SandboxNetworkPolicy } from "@sixb/core/sandboxes"
import { workspaceNetwork } from "../src/workspace-network"

const api = "https://api.example.com"
const repository = "https://github.com"
const credential = "https://api.github.com"
const registry = { name: "npm", origin: "https://registry.npmjs.org" }
const baseline = {
  mode: "restricted" as const,
  allow: [
    { name: "sixb-api", origin: api },
    { name: "workspace-repository", origin: repository },
  ],
}

describe("workspace network", () => {
  test("derives minimal access when the policy is omitted", () => {
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

  test("adds what Sixb needs to a restricted policy", () => {
    // Regression proof: return an explicit restricted policy unchanged; the Sixb targets are
    // missing. Drop credentialOrigins from the required targets; the auth origin is missing.
    const policy = { mode: "restricted" as const, allow: [registry] }

    expect(workspaceNetwork(policy, api, repository, [credential])).toEqual({
      mode: "restricted",
      allow: [registry, ...baseline.allow, { name: "workspace-auth", origin: credential }],
    })
    expect(workspaceNetwork({ mode: "restricted", allow: [] }, api)).toEqual({
      mode: "restricted",
      allow: [baseline.allow[0]],
    })
  })

  test("keeps the project's name for an origin it already lists", () => {
    const github = { name: "github", origin: repository }

    expect(
      workspaceNetwork({ mode: "restricted", allow: [github] }, api, repository, [repository])
    ).toEqual({ mode: "restricted", allow: [github, baseline.allow[0]] })
  })

  test("opens credential origins once, without repeating required ones", () => {
    const inferred: SandboxNetworkPolicy = {
      mode: "restricted",
      allow: [...baseline.allow, { name: "workspace-auth", origin: credential }],
    }

    expect(workspaceNetwork(undefined, api, repository, [credential, credential, api])).toEqual(
      inferred
    )
  })

  test("keeps an all policy unchanged", () => {
    const policy: SandboxNetworkPolicy = { mode: "all" }

    expect(workspaceNetwork(policy, api, repository, [credential])).toBe(policy)
  })

  test("rejects a none policy with the restricted alternative", () => {
    // Regression proof: treat none like an empty restricted policy; the call stops throwing.
    expect(() => workspaceNetwork({ mode: "none" }, api, repository)).toThrow(
      'Sandbox network mode "none" cannot run an agent'
    )
    expect(() => workspaceNetwork({ mode: "none" }, api)).toThrow('{ mode: "restricted"')
  })
})
