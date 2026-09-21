import { expect, test } from "bun:test"
import { param } from "@sixb/core"
import { VercelSandboxFactory } from "../src"

test("carries only common configuration, not provider credentials or infrastructure", () => {
  const factory = new VercelSandboxFactory({
    runtime: "node24",
    credentials: { token: "private", teamId: "team", projectId: "project" },
    source: { type: "git", url: "https://github.com/acme/app.git" },
    setup: ["bun install"],
  })
  expect(factory.configuration).toEqual({
    source: { type: "git", url: "https://github.com/acme/app.git" },
    setup: ["bun install"],
  })
})

test("preserves legacy native sources without admitting them as managed Git environments", () => {
  for (const source of [
    { type: "tarball" as const, url: "https://example.com/app.tgz" },
    { type: "git" as const, url: "https://github.com/acme/app.git", password: "private" },
    { type: "git" as const, url: "https://github.com/acme/app.git", depth: 1 },
  ]) {
    expect(new VercelSandboxFactory({ source }).configuration).toBeUndefined()
    expect(() => new VercelSandboxFactory({ source, setup: ["bun install"] })).toThrow(
      "Managed environments require"
    )
  }
})

test("carries dynamic configuration without evaluating it or provisioning a sandbox", () => {
  const resolve = () => {
    throw new Error("Not called at configuration time")
  }
  const params = { clientId: param("string") }
  const factory = new VercelSandboxFactory({ params, resolve })
  expect(factory.configuration).toEqual({ params, resolve })
})
