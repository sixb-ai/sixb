import { expect, test } from "bun:test"
import { withAutomaticPromptCaching } from "../src/provider-caching"

// Enabling caching for unconfigured providerOptions and a turn's own opt-out are proven on the
// wire in provider.test.ts. These rows keep explicit project configuration intact.
test.each([
  // Regression proof: remove the caching === off guard.
  ["a turn opt-out", { gateway: { zeroDataRetention: true } }, "off"],
  ["an explicit project opt-out", { gateway: { caching: null } }, undefined],
] as const)("returns configured options unchanged for %s", (_name, configured, caching) => {
  expect(withAutomaticPromptCaching(configured, caching)).toBe(configured)
})

test("enables Gateway automatic caching alongside other project options", () => {
  expect(
    withAutomaticPromptCaching({
      gateway: { zeroDataRetention: true, disallowPromptTraining: true },
    })
  ).toEqual({
    gateway: { caching: "auto", zeroDataRetention: true, disallowPromptTraining: true },
  })
})
