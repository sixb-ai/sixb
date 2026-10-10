/**
 * Language of the screens the generated runtime draws around a custom app. Imported through
 * `@sixb/app` so a project builds whether or not it depends on `@sixb/ui` itself, the same way the
 * built-in agent routes resolve `@sixb/agent-ui`.
 */
import { defineMessages, LocaleProvider, negotiateLocale } from "@sixb/ui/lib/i18n"
import { type AppMessages, en, fr } from "./locale-messages"

const appMessages = defineMessages<AppMessages>({ en, fr })

export { LocaleProvider }

/** Messages of the generated screens in the current locale. */
export const useAppMessages = appMessages.useMessages

/** The browser's first language with a translation, for pages without project settings. */
export function browserAppLocale(): string {
  return negotiateLocale({ preferred: typeof navigator === "undefined" ? [] : navigator.languages })
}

/** Messages for screens drawn before React starts, in the browser's language. */
export function browserAppMessages(): AppMessages {
  return appMessages.messagesFor(browserAppLocale())
}
