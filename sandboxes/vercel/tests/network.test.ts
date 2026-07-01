import { describe, expect, test } from "bun:test"
import { toVercelNetworkPolicy } from "../src/network"

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
