import { expect, test } from "bun:test"
import { untranslatedMessages } from "@sixb/ui/lib/i18n"
import { browserAppMessages } from "../src/locale"
import { en, fr } from "../src/locale-messages"
import { en as dataEn, fr as dataFr } from "../src/pages/console/data/messages"
import { en as consoleEn, fr as consoleFr } from "../src/pages/console/messages"
import {
  en as actionButtonEn,
  fr as actionButtonFr,
} from "../src/pages/console/ontology/components/action-button"
import { en as lineageEn, fr as lineageFr } from "../src/pages/console/ontology/lineage/messages"
import { en as sectionUiEn, fr as sectionUiFr } from "../src/pages/section-ui"
import { en as activityEn, fr as activityFr } from "../src/pages/settings/activity/messages"
import { en as settingsEn, fr as settingsFr } from "../src/pages/settings/messages"
import { en as aiUsageEn, fr as aiUsageFr } from "../src/pages/settings/usage/messages"
import { en as valuesEn, fr as valuesFr } from "../src/pages/values"

test("translates every generated screen into French", () => {
  expect(untranslatedMessages(en, fr)).toEqual([])
  expect(untranslatedMessages(settingsEn, settingsFr)).toEqual([])
  expect(untranslatedMessages(dataEn, dataFr)).toEqual([])
  expect(untranslatedMessages(sectionUiEn, sectionUiFr)).toEqual([])
  expect(untranslatedMessages(consoleEn, consoleFr)).toEqual([])
  expect(untranslatedMessages(aiUsageEn, aiUsageFr)).toEqual([])
  expect(untranslatedMessages(activityEn, activityFr)).toEqual([])
  expect(untranslatedMessages(valuesEn, valuesFr)).toEqual([])
  expect(untranslatedMessages(actionButtonEn, actionButtonFr)).toEqual([])
  expect(untranslatedMessages(lineageEn, lineageFr)).toEqual([])
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
