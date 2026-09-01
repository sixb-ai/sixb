import { describe, expect, test } from "bun:test"
import { parsePromoteOptions } from "../promote-options"

describe("promote options", () => {
  test("defaults to an executable next-to-latest promotion", () => {
    expect(parsePromoteOptions([])).toEqual({
      sourceTag: "next",
      targetTag: "latest",
      planOnly: false,
    })
  })

  test("accepts a read-only custom promotion plan", () => {
    expect(
      parsePromoteOptions([
        "--plan",
        "--from",
        "beta",
        "--to",
        "stable",
        "--registry",
        "http://localhost:4873",
      ])
    ).toEqual({
      sourceTag: "beta",
      targetTag: "stable",
      planOnly: true,
      registry: "http://localhost:4873",
    })
  })

  test("accepts one OTP for a short legacy-authenticated promotion", () => {
    expect(parsePromoteOptions(["--otp", "123456"])).toMatchObject({ otp: "123456" })
  })

  test("rejects unknown arguments and missing values", () => {
    expect(() => parsePromoteOptions(["--from"])).toThrow("--from needs a value")
    expect(() => parsePromoteOptions(["--wat"])).toThrow("[--from <tag>]")
  })
})
