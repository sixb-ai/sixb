import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PaginationNext, PaginationPrevious } from "../src/components/ui/pagination"
import { Spinner } from "../src/components/ui/spinner"
import { LocaleProvider, UiLabelsProvider, useLocale } from "../src/lib/i18n"
import { negotiateLocale, negotiateLocales } from "../src/lib/i18n/locale"
import { defineMessages, untranslatedMessages } from "../src/lib/i18n/messages"
import { en } from "../src/lib/i18n/messages/en"
import { fr } from "../src/lib/i18n/messages/fr"
import { speechErrorMessage } from "../src/lib/speech"

describe("locale negotiation", () => {
  test("prefers an explicit locale, then supported browser languages, then the fallback", () => {
    // An explicit locale is used as given, even without a translation of its own.
    expect(negotiateLocale({ locale: "de-de", preferred: ["fr-FR"] })).toBe("de-DE")
    expect(negotiateLocale({ preferred: ["de-DE", "fr-CA", "en-US"], fallback: "en" })).toBe(
      "fr-CA"
    )
    expect(negotiateLocale({ preferred: ["de-DE", "not a tag"], fallback: "fr-FR" })).toBe("fr-FR")
    expect(negotiateLocale({ preferred: ["de-DE"], fallback: "es" })).toBe("en")
    expect(negotiateLocale({})).toBe("en")
  })

  test("formats in the first browser language even when text falls back to another", () => {
    // Proven by removal: return the message locale as the format locale in negotiateLocales.
    expect(negotiateLocales({ preferred: ["de-CH", "fr-FR"], fallback: "en" })).toEqual({
      format: "de-CH",
      messages: "fr-FR",
    })
    expect(negotiateLocales({ preferred: [], fallback: "fr-FR" })).toEqual({
      format: "fr-FR",
      messages: "fr-FR",
    })
    expect(negotiateLocales({ locale: "es", preferred: ["de-CH"] })).toEqual({
      format: "es",
      messages: "es",
    })
  })

  test("speaks English without a provider and inherits a parent's locale", () => {
    function Locale() {
      return <>{useLocale()}</>
    }
    expect(renderToStaticMarkup(<Locale />)).toBe("en")
    expect(
      renderToStaticMarkup(
        <LocaleProvider locale="fr-CA">
          <LocaleProvider fallbackLocale="en">
            <Locale />
          </LocaleProvider>
        </LocaleProvider>
      )
    ).toBe("fr-CA")
  })
})

describe("messages", () => {
  test("translates every @sixb/ui message into French", () => {
    expect(untranslatedMessages(en, fr)).toEqual([])
  })

  test("reads the base language, falls back to English, and applies labels", () => {
    const catalog = defineMessages({
      en: { greeting: "Hello", nested: { count: (n: number) => `${n} items` } },
      fr: { greeting: "Bonjour", nested: { count: (n: number) => `${n} éléments` } },
    })
    expect(catalog.messagesFor("fr-CA").greeting).toBe("Bonjour")
    expect(catalog.messagesFor("de-DE").nested.count(2)).toBe("2 items")
    // A catalog missing a translation at runtime still answers in English.
    const partial = defineMessages({
      en: { greeting: "Hello", farewell: "Goodbye" },
      fr: { greeting: "Bonjour" } as never,
    })
    expect(partial.messagesFor("fr").farewell).toBe("Goodbye")
  })

  test("renders component text in the provider's language with labels on top", () => {
    const pagination = (
      <>
        <PaginationPrevious href="#" />
        <PaginationNext href="#" />
        <Spinner />
      </>
    )
    expect(renderToStaticMarkup(pagination)).toContain('aria-label="Go to previous page"')
    const french = renderToStaticMarkup(
      <LocaleProvider locale="fr-FR">
        <UiLabelsProvider labels={{ pagination: { next: "Page d’après" } }}>
          {pagination}
        </UiLabelsProvider>
      </LocaleProvider>
    )
    expect(french).toContain('aria-label="Page précédente"')
    expect(french).toContain(">Précédent</span>")
    expect(french).toContain(">Page d’après</span>")
    expect(french).toContain('aria-label="Chargement"')
  })

  test("keeps English speech errors as the default of the public helper", () => {
    expect(speechErrorMessage("network")).toBe(en.speech.network)
    expect(speechErrorMessage("network", fr.speech)).toBe(fr.speech.network)
  })
})
