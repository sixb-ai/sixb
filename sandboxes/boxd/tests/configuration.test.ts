import { expect, test } from "bun:test"
import { param } from "@sixb/core"
import { BoxdSandboxFactory, type BoxdSandboxFactoryOptions } from "../src"

test("carries only common configuration, not provider credentials or infrastructure", () => {
  const factory = new BoxdSandboxFactory({
    apiKey: "private",
    org: "acme",
    region: "fra",
    size: "2x8",
    source: { type: "git", url: "https://github.com/acme/app.git" },
    setup: ["bun install"],
  })
  expect(factory.configuration).toEqual({
    source: { type: "git", url: "https://github.com/acme/app.git" },
    setup: ["bun install"],
  })

  // A dynamic recipe is carried as given, never evaluated at configuration time.
  const resolve = () => {
    throw new Error("Not called at configuration time")
  }
  const params = { clientId: param("string") }
  const dynamic = new BoxdSandboxFactory({ apiKey: "private", params, resolve })
  expect(dynamic.configuration).toEqual({ params, resolve })
})

test("rejects provider-specific source variants at construction", () => {
  for (const source of [
    { type: "tarball" as const, url: "https://example.com/app.tgz" },
    { type: "git" as const, url: "https://github.com/acme/app.git", password: "private" },
  ]) {
    expect(
      () =>
        new BoxdSandboxFactory<Record<never, never>>({ source } as BoxdSandboxFactoryOptions<
          Record<never, never>
        >)
    ).toThrow("Invalid sandbox source")
  }
})

test("rejects an unknown size or an invalid name prefix at construction", () => {
  expect(() => new BoxdSandboxFactory({ size: "3x12" as never })).toThrow("size")
  expect(() => new BoxdSandboxFactory({ namePrefix: "Sixb_" })).toThrow("namePrefix")
  expect(() => new BoxdSandboxFactory({ readyTimeoutMs: 0 })).toThrow("readyTimeoutMs")
})

test("supports request credentials and named persistence", () => {
  const factory = new BoxdSandboxFactory()
  expect(factory.supportsRequestCredentials).toBe(true)
  expect(typeof factory.resume).toBe("function")
})
