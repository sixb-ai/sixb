import { describe, expect, test } from "bun:test"
import { withAutomaticPromptCaching } from "../src/provider-caching"

describe("withAutomaticPromptCaching", () => {
  test("lets a turn disable automatic caching without replacing explicit options", () => {
    // Regression proof: remove the caching === off guard.
    expect(withAutomaticPromptCaching(undefined, "off")).toBeUndefined()
    const configured = { gateway: { caching: "auto" } }
    expect(withAutomaticPromptCaching(configured, "off")).toBe(configured)
  })
  test("enables the Gateway automatic caching path and preserves project options", () => {
    expect(
      withAutomaticPromptCaching({
        gateway: {
          zeroDataRetention: true,
          disallowPromptTraining: true,
        },
      })
    ).toEqual({
      gateway: {
        caching: "auto",
        zeroDataRetention: true,
        disallowPromptTraining: true,
      },
    })
  })

  test("preserves an explicit project caching value", () => {
    const configured = {
      gateway: {
        caching: "auto",
        zeroDataRetention: true,
      },
    }

    expect(withAutomaticPromptCaching(configured)).toBe(configured)
  })

  test("enables caching when no options are supplied", () => {
    expect(withAutomaticPromptCaching(undefined)).toEqual({ gateway: { caching: "auto" } })
  })

  test("does not override an explicit opt-out", () => {
    const configured = { gateway: { caching: null } }
    expect(withAutomaticPromptCaching(configured)).toBe(configured)
  })
})
