import { describe, expect, test } from "bun:test"
import { parsePromoteOptions } from "../promote-options"

describe("promote options", () => {
  test.each<{ name: string; argv: string[]; options: ReturnType<typeof parsePromoteOptions> }>([
    {
      name: "defaults to an executable next-to-latest promotion",
      argv: [],
      options: { sourceTag: "next", targetTag: "latest", planOnly: false },
    },
    {
      name: "accepts a read-only custom promotion plan",
      argv: ["--plan", "--from", "beta", "--to", "stable", "--registry", "http://localhost:4873"],
      options: {
        sourceTag: "beta",
        targetTag: "stable",
        planOnly: true,
        registry: "http://localhost:4873",
      },
    },
    {
      name: "accepts one OTP for a short legacy-authenticated promotion",
      argv: ["--otp", "123456"],
      options: { sourceTag: "next", targetTag: "latest", planOnly: false, otp: "123456" },
    },
  ])("$name", ({ argv, options }) => {
    expect(parsePromoteOptions(argv)).toEqual(options)
  })

  test("rejects unknown arguments and missing values", () => {
    expect(() => parsePromoteOptions(["--from"])).toThrow("--from needs a value")
    expect(() => parsePromoteOptions(["--wat"])).toThrow("[--from <tag>]")
  })
})
