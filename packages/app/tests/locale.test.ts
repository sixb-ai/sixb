import { expect, test } from "bun:test"
import { untranslatedMessages } from "@sixb/ui/lib/i18n"
import { browserAppMessages } from "../src/locale"
import { en, fr } from "../src/locale-messages"

test("translates every generated screen into French", () => {
  expect(untranslatedMessages(en, fr)).toEqual([])
})

test("screens drawn before React follow the browser's languages", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  try {
    for (const [languages, title] of [
      [["de-DE", "fr-CA"], "Lien indisponible"],
      [["de-DE"], "Link unavailable"],
    ] as const) {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages } })
      expect(browserAppMessages().shared.unavailableTitle).toBe(title)
    }
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original)
  }
})
