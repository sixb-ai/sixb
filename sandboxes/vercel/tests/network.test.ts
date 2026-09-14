import { describe, expect, test } from "bun:test"
import type { SandboxRequestCredential } from "@sixb/core/sandboxes"
import { toVercelNetworkPolicy, withRequestCredentials } from "../src/network"

describe("credential injection policy", () => {
  const credential: SandboxRequestCredential = {
    origin: "https://github.com",
    path: "/acme/repo.git/info/refs",
    method: "GET",
    headers: { Authorization: "Basic test" },
  }
  test("uses exact path and method without replacing unrelated egress rules", () => {
    expect(
      withRequestCredentials(
        {
          mode: "restricted",
          allow: [
            { name: "github", origin: "https://github.com" },
            { name: "npm", origin: "https://registry.npmjs.org" },
          ],
        },
        [credential]
      )
    ).toEqual({
      allow: {
        "github.com": [
          {
            match: { path: { exact: "/acme/repo.git/info/refs" }, method: ["GET"] },
            transform: [{ headers: { Authorization: "Basic test" } }],
          },
        ],
        "registry.npmjs.org": [],
      },
    })
  })
  test("keeps unrestricted access only when explicitly requested", () => {
    expect(withRequestCredentials({ mode: "all" }, [credential])).toMatchObject({
      allow: { "*": [] },
    })
    expect(withRequestCredentials({ mode: "all" }, [])).toBe("allow-all")
  })
  test.each([
    { origin: "https://evil.com" },
    { origin: "http://github.com" },
    { origin: "https://github.com:444" },
    { path: "/acme/../other" },
    { path: "/acme/%2e%2e/other" },
    { path: "/acme/repo?secret=x" },
    { headers: { Authorization: "secret\r\nHeader: value" } },
  ])("rejects malformed or unapproved destinations: %j", (override) => {
    expect(() =>
      withRequestCredentials(
        {
          mode: "restricted",
          allow: [{ name: "git", origin: "https://github.com" }],
        },
        [{ ...credential, ...override }]
      )
    ).toThrow()
  })
  test("cannot add access to a blocked domain", () => {
    expect(() => withRequestCredentials({ mode: "none" }, [credential])).toThrow()
  })
})

describe("toVercelNetworkPolicy", () => {
  test("maps deny-all and allow-all modes", () => {
    expect(toVercelNetworkPolicy(undefined)).toBe("deny-all")
    expect(toVercelNetworkPolicy({ mode: "none" })).toBe("deny-all")
    expect(toVercelNetworkPolicy({ mode: "all" })).toBe("allow-all")
  })

  test("maps empty restricted allow list to deny-all", () => {
    expect(toVercelNetworkPolicy({ mode: "restricted", allow: [] })).toBe("deny-all")
  })

  test("maps HTTPS restricted targets to domain allow rules", () => {
    expect(
      toVercelNetworkPolicy({
        mode: "restricted",
        allow: [
          { name: "sixb-api", origin: "https://api.example.com:443" },
          { name: "assets", origin: "https://assets.example.com" },
        ],
      })
    ).toEqual({ allow: ["api.example.com", "assets.example.com"] })
  })

  test("maps IP targets to subnet allow rules", () => {
    expect(
      toVercelNetworkPolicy({
        mode: "restricted",
        allow: [
          { name: "gateway", origin: "http://10.0.0.5:3002" },
          { name: "v6", origin: "https://[2001:db8::1]:8443" },
        ],
      })
    ).toEqual({ subnets: { allow: ["10.0.0.5/32", "2001:db8::1/128"] } })
  })

  test("rejects loopback targets because Vercel runs remotely", () => {
    expect(() =>
      toVercelNetworkPolicy({
        mode: "restricted",
        allow: [{ name: "local", origin: "http://127.0.0.1:3002" }],
      })
    ).toThrow("cannot reach restricted target")
  })

  test("rejects plain HTTP hostname targets because Vercel domain filtering is TLS-only", () => {
    expect(() =>
      toVercelNetworkPolicy({
        mode: "restricted",
        allow: [{ name: "api", origin: "http://api.example.com" }],
      })
    ).toThrow("plain HTTP")
  })
})
