import { expect, test } from "bun:test"
import { SixbApiError } from "@sixb/client"
import { requesterSettings, sendWithRequesterSettings } from "../src/requesterSettings"

test("sends only the hints this browser's Intl can use", () => {
  // Proven by removal: return the raw browser values from requesterSettings.
  expect(requesterSettings("europe/paris", "fr-fr")).toEqual({
    timeZone: "Europe/Paris",
    locale: "fr-FR",
  })
  expect(requesterSettings("Etc/Unknown", "fr_FR")).toEqual({})
  expect(requesterSettings("Mars/Olympus", undefined)).toEqual({})
})

test("resends once without the hints when the server refuses them", async () => {
  // Proven by removal: rethrow every error from sendWithRequesterSettings.
  const sent: object[] = []
  const refuse = new SixbApiError("refused", { status: 400, body: { code: "invalid_locale" } })
  const result = await sendWithRequesterSettings(
    async (settings) => {
      sent.push(settings)
      if (settings.timeZone) throw refuse
      return "accepted"
    },
    { timeZone: "Europe/Paris" }
  )
  expect(result).toBe("accepted")
  expect(sent).toEqual([{ timeZone: "Europe/Paris" }, {}])

  const other = new SixbApiError("busy", { status: 409, body: { code: "active_run_exists" } })
  await expect(
    sendWithRequesterSettings(
      async () => {
        throw other
      },
      { timeZone: "Europe/Paris" }
    )
  ).rejects.toBe(other)
})
