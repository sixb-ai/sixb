import { expect, test } from "bun:test"
import { param } from "../src"
import { sandboxConfig } from "../src/sandboxes/config"

test("captures common defaults without retaining caller-owned environment data", () => {
  const options = {
    source: { type: "git" as const, url: "https://example.com/app.git" },
    setup: ["prepare"],
    env: { MODE: "test" },
    network: {
      mode: "restricted" as const,
      allow: [{ name: "source", origin: "https://example.com" }],
    },
  }
  const config = sandboxConfig(options)
  options.setup.push("unexpected")
  options.source.url = "https://other.example.com/app.git"
  options.env.MODE = "changed"
  options.network.allow.length = 0
  expect(config.setup).toEqual(["prepare"])
  expect(config.source?.url).toBe("https://example.com/app.git")
  expect(config.env).toEqual({ MODE: "test" })
  expect(config.network).toMatchObject({
    allow: [{ name: "source", origin: "https://example.com" }],
  })
})

test("rejects ambiguous recipes before registration or provisioning", () => {
  expect(() => sandboxConfig({ params: { id: param("string") } })).toThrow("require a resolve")
  expect(() => sandboxConfig({ setup: [], resolve: () => ({}) })).toThrow("not both")
  expect(() =>
    sandboxConfig({ source: { type: "git", url: "https://secret@example.com" } })
  ).toThrow("credential-free HTTPS")
})
