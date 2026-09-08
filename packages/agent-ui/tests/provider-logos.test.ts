import { expect, test } from "bun:test"
import { providerLogoPath } from "../src/components/provider-logos"

test("known provider icons are local SVG paths; unknown names use the initial fallback", () => {
  for (const id of [
    "openai",
    "anthropic",
    "deepseek",
    "google",
    "spacexai",
    "zai",
    "meta",
    "moonshotai",
    "nvidia",
  ]) {
    expect(providerLogoPath(id)).toMatch(/^M/)
  }
  for (const id of ["custom", "constructor", "__proto__"]) {
    expect(providerLogoPath(id)).toBeUndefined()
  }
})
