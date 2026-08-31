import { describe, expect, test } from "bun:test"
import { parsePublishOptions } from "../publish-options"

describe("publish options", () => {
  test("defaults to a latest publication", () => {
    expect(parsePublishOptions([])).toEqual({
      dryRun: false,
      planOnly: false,
      tag: "latest",
    })
  })

  test("accepts an interactive web-authenticated release", () => {
    expect(parsePublishOptions(["--tag", "next", "--auth-type", "web"])).toEqual({
      authType: "web",
      dryRun: false,
      planOnly: false,
      tag: "next",
    })
  })

  test("keeps legacy OTP and registry options available", () => {
    expect(
      parsePublishOptions([
        "--dry-run",
        "--auth-type",
        "legacy",
        "--otp",
        "123456",
        "--registry",
        "http://localhost:4873",
      ])
    ).toEqual({
      authType: "legacy",
      dryRun: true,
      planOnly: false,
      tag: "latest",
      otp: "123456",
      registry: "http://localhost:4873",
    })
  })

  test("rejects unsupported authentication types", () => {
    expect(() => parsePublishOptions(["--auth-type", "passkey"])).toThrow(
      '--auth-type must be "web" or "legacy"'
    )
  })

  test("does not silently turn web authentication into an OTP flow", () => {
    expect(() => parsePublishOptions(["--auth-type", "web", "--otp", "123456"])).toThrow(
      "--auth-type web cannot be combined with --otp"
    )
  })

  test("reports missing values and the complete usage", () => {
    expect(() => parsePublishOptions(["--auth-type"])).toThrow("--auth-type needs a value")
    expect(() => parsePublishOptions(["--wat"])).toThrow("[--auth-type <web|legacy>]")
  })
})
