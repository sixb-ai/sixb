import { isSixbApiError } from "@sixb/client"

export interface RequesterSettings {
  readonly timeZone?: string
  readonly locale?: string
}

/**
 * The browser's time zone and language, so the Agent answers in the user's local time. Hints only:
 * values this browser's own `Intl` cannot use are dropped rather than sent.
 */
export function requesterSettings(
  timeZone: string | undefined = Intl.DateTimeFormat().resolvedOptions().timeZone,
  language: string | undefined = typeof navigator === "undefined" ? undefined : navigator.language
): RequesterSettings {
  const zone = usableTimeZone(timeZone)
  const locale = usableLocale(language)
  return { ...(zone ? { timeZone: zone } : {}), ...(locale ? { locale } : {}) }
}

/**
 * Send with the browser's hints, and once more without them if the server refuses them: a hint
 * must never cost the user their message.
 */
export async function sendWithRequesterSettings<TResult>(
  send: (settings: RequesterSettings) => Promise<TResult>,
  settings: RequesterSettings = requesterSettings()
): Promise<TResult> {
  try {
    return await send(settings)
  } catch (error) {
    const refused = isSixbApiError(error) && error.code === "invalid_locale"
    if (!refused || (settings.timeZone === undefined && settings.locale === undefined)) throw error
    return send({})
  }
}

function usableTimeZone(value: string | undefined): string | undefined {
  // ICU reports `Etc/Unknown` when the system zone cannot be determined.
  if (!value || value === "Etc/Unknown") return undefined
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

function usableLocale(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return Intl.getCanonicalLocales(value)[0]
  } catch {
    return undefined
  }
}
