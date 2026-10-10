import { createContext, type ReactNode, useContext, useMemo } from "react"

/** Languages every framework catalog translates. English is the source of the others. */
export const SUPPORTED_LANGUAGES = ["en", "fr"] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LOCALE = "en"

/**
 * Text and formats may differ: a reader whose first language has no translation still gets their
 * own dates and numbers, while text falls back to a language the framework speaks.
 */
interface Locales {
  /** For `Intl` dates and numbers: the first browser language. */
  readonly format: string
  /** For framework text: the first language with a translation. */
  readonly messages: string
}

// Without a provider the framework speaks English: Atlas and other tools never set one.
const LocaleContext = createContext<Locales | undefined>(undefined)

export interface LocaleProviderProps {
  /** Forces this BCP 47 locale, for example from a user setting. */
  readonly locale?: string
  /** Used when none of the browser's languages is supported, typically the project locale. */
  readonly fallbackLocale?: string
  readonly children?: ReactNode
}

/**
 * Selects the language and formats of framework components below it. Nested providers keep the
 * locale of their parent unless they set `locale`.
 */
export function LocaleProvider({ locale, fallbackLocale, children }: LocaleProviderProps) {
  const parent = useContext(LocaleContext)
  const browserLanguages = typeof navigator === "undefined" ? [] : navigator.languages
  const resolved = useMemo(
    () =>
      locale === undefined && parent !== undefined
        ? parent
        : negotiateLocales({ locale, preferred: browserLanguages, fallback: fallbackLocale }),
    [locale, parent, browserLanguages, fallbackLocale]
  )
  return <LocaleContext.Provider value={resolved}>{children}</LocaleContext.Provider>
}

/** The BCP 47 locale `Intl` dates and numbers use, `"en"` without a provider. */
export function useLocale(): string {
  return useContext(LocaleContext)?.format ?? DEFAULT_LOCALE
}

/** The BCP 47 locale framework text is written in, `"en"` without a provider. */
export function useMessageLocale(): string {
  return useContext(LocaleContext)?.messages ?? DEFAULT_LOCALE
}

/**
 * Both locales of a reader. An explicit locale sets both. Otherwise text takes the first language
 * with a translation ({@link negotiateLocale}) and formats the first valid browser language, then
 * the fallback, then English.
 */
export function negotiateLocales(input: {
  readonly locale?: string
  readonly preferred?: readonly string[]
  readonly fallback?: string
}): Locales {
  const explicit = canonicalLocale(input.locale)
  if (explicit) return { format: explicit, messages: explicit }
  const format =
    [...(input.preferred ?? []), input.fallback]
      .map(canonicalLocale)
      .find((locale) => locale !== undefined) ?? DEFAULT_LOCALE
  return { format, messages: negotiateLocale(input) }
}

/**
 * An explicit locale wins as given. Otherwise the first preferred language with a translation
 * wins, then the fallback when it has one, then English.
 */
export function negotiateLocale(input: {
  readonly locale?: string
  readonly preferred?: readonly string[]
  readonly fallback?: string
}): string {
  const explicit = canonicalLocale(input.locale)
  if (explicit) return explicit
  for (const candidate of [...(input.preferred ?? []), input.fallback]) {
    const locale = canonicalLocale(candidate)
    if (locale && supportedLanguage(locale)) return locale
  }
  return DEFAULT_LOCALE
}

/** The translated language serving a locale: `fr-CA` → `fr`, `undefined` without a catalog. */
export function supportedLanguage(locale: string): SupportedLanguage | undefined {
  const language = locale.split("-")[0]?.toLowerCase()
  return SUPPORTED_LANGUAGES.find((supported) => supported === language)
}

function canonicalLocale(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return Intl.getCanonicalLocales(value)[0]
  } catch {
    return undefined
  }
}
