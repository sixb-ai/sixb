import { createContext, type ReactNode, useContext, useMemo } from "react"
import { type SupportedLanguage, supportedLanguage, useMessageLocale } from "./locale"

/** Text, or a typed function for text with values. Plurals use {@link plural}. */
export type Message = string | ((...values: never[]) => string)

/** Messages grouped by the part of the interface that shows them. */
export interface MessageTree {
  readonly [key: string]: Message | MessageTree
}

/** The same messages as the source catalog, with the same function signatures. */
export type Translation<TMessages extends MessageTree> = {
  readonly [K in keyof TMessages]: TMessages[K] extends string
    ? string
    : TMessages[K] extends MessageTree
      ? Translation<TMessages[K]>
      : TMessages[K]
}

/** Partial rewording of a catalog, applied in every language. */
export type Labels<TMessages extends MessageTree> = {
  readonly [K in keyof TMessages]?: TMessages[K] extends string
    ? string
    : TMessages[K] extends MessageTree
      ? Labels<TMessages[K]>
      : TMessages[K]
}

/** English is the source; every other supported language must translate all of it. */
export type MessageCatalogs<TMessages extends MessageTree> = { readonly en: TMessages } & {
  readonly [Language in Exclude<SupportedLanguage, "en">]: Translation<TMessages>
}

export interface LabelsProviderProps<TMessages extends MessageTree> {
  readonly labels?: Labels<TMessages>
  readonly children?: ReactNode
}

export interface MessageCatalog<TMessages extends MessageTree> {
  /** Messages for a locale: `fr-CA` reads `fr`, an unsupported language reads English. */
  messagesFor(locale: string): TMessages
  /** The messages for the current locale, with any labels supplied above. */
  useMessages(): TMessages
  /** Rewords messages below it. Nested providers add to the labels of their parent. */
  LabelsProvider(props: LabelsProviderProps<TMessages>): ReactNode
}

/** Build one package's catalog. Missing translations fall back to English at runtime too. */
export function defineMessages<TMessages extends MessageTree>(
  catalogs: MessageCatalogs<TMessages>
): MessageCatalog<TMessages> {
  const LabelsContext = createContext<Labels<TMessages> | undefined>(undefined)
  const byLanguage = new Map<SupportedLanguage, TMessages>()

  function messagesFor(locale: string): TMessages {
    const language = supportedLanguage(locale) ?? "en"
    let messages = byLanguage.get(language)
    if (!messages) {
      messages =
        language === "en"
          ? catalogs.en
          : mergeMessages(catalogs.en, catalogs[language] as Labels<TMessages>)
      byLanguage.set(language, messages)
    }
    return messages
  }

  function useMessages(): TMessages {
    const locale = useMessageLocale()
    const labels = useContext(LabelsContext)
    return useMemo(
      () => (labels ? mergeMessages(messagesFor(locale), labels) : messagesFor(locale)),
      [locale, labels]
    )
  }

  function LabelsProvider({ labels, children }: LabelsProviderProps<TMessages>) {
    const parent = useContext(LabelsContext)
    const merged = useMemo(
      () => (parent && labels ? mergeLabels(parent, labels) : (labels ?? parent)),
      [parent, labels]
    )
    return <LabelsContext.Provider value={merged}>{children}</LabelsContext.Provider>
  }

  return { messagesFor, useMessages, LabelsProvider }
}

/** Pick the plural form of `count` with the language's rules, e.g. `one` or `other`. */
export function plural(
  language: SupportedLanguage,
  count: number,
  forms: { readonly one: string; readonly other: string }
): string {
  return new Intl.PluralRules(language).select(count) === "one" ? forms.one : forms.other
}

/**
 * Paths of the source messages a translation misses, mistypes, or leaves empty. TypeScript checks
 * the shape of a catalog; this also catches what it cannot see, for a test to assert `[]`.
 */
export function untranslatedMessages(
  source: MessageTree,
  translation: unknown,
  path = ""
): readonly string[] {
  return Object.entries(source).flatMap(([key, message]) => {
    const translated = (translation as Record<string, unknown> | undefined)?.[key]
    const at = `${path}${key}`
    if (typeof message === "object") return untranslatedMessages(message, translated, `${at}.`)
    return typeof translated === typeof message && translated !== "" ? [] : [at]
  })
}

function mergeMessages<TMessages extends MessageTree>(
  messages: TMessages,
  labels: Labels<TMessages>
): TMessages {
  return mergeLabels(messages as Labels<TMessages>, labels) as TMessages
}

function mergeLabels<TMessages extends MessageTree>(
  base: Labels<TMessages>,
  labels: Labels<TMessages>
): Labels<TMessages> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined) continue
    const current = merged[key]
    merged[key] =
      isMessageTree(current) && isMessageTree(value) ? mergeLabels(current, value) : value
  }
  return merged as Labels<TMessages>
}

function isMessageTree(value: unknown): value is MessageTree {
  return typeof value === "object" && value !== null
}
