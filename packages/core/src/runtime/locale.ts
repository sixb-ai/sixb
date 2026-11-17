/** Language assumed when a project sets none. */
export const DEFAULT_PROJECT_LOCALE = "en"

/** Time zone assumed when a project sets none; cron schedules have always used it. */
export const DEFAULT_PROJECT_TIME_ZONE = "UTC"

/** The canonical form of a BCP 47 language tag (`fr-fr` → `fr-FR`), or `undefined` if invalid. */
export function canonicalLocale(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const [locale] = Intl.getCanonicalLocales(value)
    return locale
  } catch {
    return undefined
  }
}
