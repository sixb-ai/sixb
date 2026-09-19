import { expect, test } from "bun:test"
import { resolveNetwork } from "../src/network"

for (const policy of [undefined, { mode: "none" }, { mode: "restricted", allow: [] }] as const) {
  test(`deny all for ${JSON.stringify(policy)}`, () => {
    expect(resolveNetwork(policy)).toEqual({
      policy: { mode: "none" },
      egress: { defaultAction: "Deny", trafficInspection: "Full", hostRules: [] },
    })
  })
}
test("all explicitly disables Azure inspection", () => {
  expect(resolveNetwork({ mode: "all" }).egress).toEqual({
    defaultAction: "Allow",
    trafficInspection: "None",
    hostRules: [],
  })
})
test("canonicalizes, deduplicates and snapshots exact HTTPS hosts", () => {
  const allow = [
    { name: "gateway", origin: "https://EXAMPLE.com:443" },
    { name: "same", origin: "https://example.com/" },
  ]
  const resolved = resolveNetwork({ mode: "restricted", allow })
  allow[0]!.origin = "https://forbidden.example"
  expect(resolved.policy).toEqual({
    mode: "restricted",
    allow: [
      { name: "gateway", origin: "https://example.com" },
      { name: "same", origin: "https://example.com" },
    ],
  })
  expect(resolved.egress).toEqual({
    defaultAction: "Deny",
    trafficInspection: "Full",
    hostRules: [{ pattern: "example.com", action: "Allow" }],
  })
})
for (const origin of [
  "http://example.com",
  "https://example.com:8443",
  "https://example.com/path",
  "https://example.com?query",
  "https://example.com#fragment",
  "https://user:password@example.com",
  "example.com",
  "https://*.example.com",
  "https://localhost",
  "https://127.0.0.1",
  "https://[::1]",
  "https://10.0.0.1",
  "https://2130706433",
  "https://instance.local",
  "https://instance.internal",
  "https://example.com.",
]) {
  test(`rejects unsupported origin ${origin}`, () => {
    // Negative control: remove origin validation in resolveNetwork; these assertions fail.
    expect(() =>
      resolveNetwork({ mode: "restricted", allow: [{ name: "gateway", origin }] })
    ).toThrow()
  })
}
