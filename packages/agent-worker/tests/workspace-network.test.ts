import { describe, expect, test } from "bun:test"
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
  test.each([
    undefined,
    { mode: "none" },
    { mode: "restricted", allow: [] },
  ])("keeps required destinations without extra access: %j", (policy) =>
    expect(workspaceNetwork(policy, api, repository)).toEqual(baseline))

  test("adds canonical origins without duplicating required access", () => {
    expect(
      workspaceNetwork(
        {
          mode: "restricted",
          allow: [
            { name: "npm", origin: "https://registry.npmjs.org/" },
            { name: "duplicate", origin: repository },
          ],
        },
        api,
        repository
      )
    ).toEqual({
      mode: "restricted",
      allow: [...baseline.allow, { name: "npm", origin: "https://registry.npmjs.org" }],
    })
  })

  test("opens Internet only on explicit all", () => {
    expect(workspaceNetwork({ mode: "all" }, api, repository)).toEqual({ mode: "all" })
  })

  test.each([
    null,
    {},
    { mode: "unknown" },
    { mode: "all", allow: [] },
    { mode: "restricted" },
    { mode: "restricted", allow: [null] },
    ...[
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
      "https://example.com#fragment",
      "file:///tmp",
      "example.com",
    ].map((origin) => ({ mode: "restricted", allow: [{ name: "invalid", origin }] })),
    { mode: "restricted", allow: [{ name: "", origin: api }] },
  ])("rejects malformed policies instead of widening access: %j", (policy) => {
    expect(() => workspaceNetwork(policy, api, repository)).toThrow("Workspace network")
  })
})
