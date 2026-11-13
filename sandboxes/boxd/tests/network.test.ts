import { expect, test } from "bun:test"
import { SandboxError } from "@sixb/core/sandboxes"
import { assertCredentialsAllowed, toBoxdEgress } from "../src/network"

const restricted = (...origins: string[]) => ({
  mode: "restricted" as const,
  allow: origins.map((origin, index) => ({ name: `target-${index}`, origin })),
})

test("a restricted network allows each origin's hostname once", () => {
  expect(
    toBoxdEgress(
      restricted("https://api.example.com", "http://api.example.com:8080", "https://203.0.113.7")
    )
  ).toEqual(["api.example.com", "203.0.113.7"])
})

test("none and an empty list reach nothing; all is unrestricted", () => {
  expect(toBoxdEgress({ mode: "none" })).toEqual(["none"])
  expect(toBoxdEgress(restricted())).toEqual(["none"])
  expect(toBoxdEgress({ mode: "all" })).toBeUndefined()
})

test("origins only this host can reach are refused with the fix", () => {
  for (const origin of [
    "http://localhost:3002",
    "http://127.0.0.1:3002",
    "http://10.0.0.5",
    "http://192.168.1.20:3002",
    "http://[::1]:3002",
  ]) {
    expect(() => toBoxdEgress(restricted(origin))).toThrow("public origin")
  }
})

test("a credential needs its exact origin in the network", () => {
  const credential = {
    origin: "https://api.example.com",
    path: "/v1/me",
    method: "GET" as const,
    headers: { Authorization: "Bearer secret" },
  }
  expect(() => assertCredentialsAllowed({ mode: "all" }, [credential])).not.toThrow()
  expect(() =>
    assertCredentialsAllowed(restricted("https://api.example.com"), [credential])
  ).not.toThrow()
  for (const policy of [{ mode: "none" as const }, restricted("https://other.example.com")]) {
    const error = (() => {
      try {
        assertCredentialsAllowed(policy, [credential])
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(SandboxError)
    expect(String(error)).not.toContain("secret")
  }
  expect(() =>
    assertCredentialsAllowed({ mode: "all" }, [{ ...credential, origin: "https://x.dev/path" }])
  ).toThrow("origin")
})
