import { describe, expect, test } from "bun:test"
import { parsePublishOptions } from "../publish-options"

describe("publish options", () => {
  test.each<{ name: string; argv: string[]; options: ReturnType<typeof parsePublishOptions> }>([
    {
      name: "defaults to a latest publication",
      argv: [],
      options: { dryRun: false, planOnly: false, tag: "latest" },
    },
    {
      name: "accepts an interactive web-authenticated release",
      argv: ["--tag", "next", "--auth-type", "web"],
      options: { authType: "web", dryRun: false, planOnly: false, tag: "next" },
    },
    {
      name: "keeps legacy OTP and registry options available",
      argv: [
        "--dry-run",
        "--auth-type",
        "legacy",
        "--otp",
        "123456",
        "--registry",
        "http://localhost:4873",
      ],
      options: {
        authType: "legacy",
        dryRun: true,
        planOnly: false,
        tag: "latest",
        otp: "123456",
        registry: "http://localhost:4873",
      },
    },
  ])("$name", ({ argv, options }) => {
    expect(parsePublishOptions(argv)).toEqual(options)
  })

  test.each<{ name: string; argv: string[]; error: string }>([
    {
      name: "rejects unsupported authentication types",
      argv: ["--auth-type", "passkey"],
      error: '--auth-type must be "web" or "legacy"',
    },
    {
      name: "does not silently turn web authentication into an OTP flow",
      argv: ["--auth-type", "web", "--otp", "123456"],
      error: "--auth-type web cannot be combined with --otp",
    },
    {
      name: "reports a missing value",
      argv: ["--auth-type"],
      error: "--auth-type needs a value",
    },
    {
      name: "reports the complete usage for an unknown argument",
      argv: ["--wat"],
      error: "[--auth-type <web|legacy>]",
    },
  ])("$name", ({ argv, error }) => {
    expect(() => parsePublishOptions(argv)).toThrow(error)
  })
})
