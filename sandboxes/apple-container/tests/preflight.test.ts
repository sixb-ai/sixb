import { describe, expect, test } from "bun:test"
import { evaluateAppleContainer } from "../src/preflight"

describe("Apple Container preflight", () => {
  test("accepts Apple silicon on macOS 26+ with the container binary", () => {
    expect(
      evaluateAppleContainer({
        bin: "container",
        platform: "darwin",
        arch: "arm64",
        darwinMajorVersion: 25,
        hasBinary: () => true,
      })
    ).toEqual({ ok: true, message: "Apple Container ready" })
  })

  test("rejects unsupported hosts", () => {
    expect(
      evaluateAppleContainer({
        bin: "container",
        platform: "linux",
        arch: "arm64",
        hasBinary: () => true,
      }).message
    ).toContain("macOS")

    expect(
      evaluateAppleContainer({
        bin: "container",
        platform: "darwin",
        arch: "x64",
        darwinMajorVersion: 25,
        hasBinary: () => true,
      }).message
    ).toContain("Apple silicon")

    expect(
      evaluateAppleContainer({
        bin: "container",
        platform: "darwin",
        arch: "arm64",
        darwinMajorVersion: 24,
        hasBinary: () => true,
      }).message
    ).toContain("macOS 26")
  })

  test("rejects a missing CLI binary", () => {
    expect(
      evaluateAppleContainer({
        bin: "container",
        platform: "darwin",
        arch: "arm64",
        darwinMajorVersion: 25,
        hasBinary: () => false,
      })
    ).toEqual({ ok: false, message: "Apple Container CLI binary 'container' not found" })
  })
})
