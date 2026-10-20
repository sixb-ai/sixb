import { useLocale } from "@sixb/ui/lib/i18n"
import { useMemo } from "react"
import { utcDay } from "./period"

export type UtcFormat = ReturnType<typeof useUtcFormat>

/** Activity counts in UTC days, so its times read in UTC too, and say so. */
export function useUtcFormat() {
  const locale = useLocale()
  return useMemo(() => {
    const thisYear = new Date().getUTCFullYear()
    const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" })
    const dayAndYear = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" })
    const clock = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" })
    const clockWithSeconds = new Intl.DateTimeFormat(locale, {
      timeStyle: "medium",
      timeZone: "UTC",
    })

    const date = (at: Date) =>
      at.getUTCFullYear() === thisYear ? day.format(at) : dayAndYear.format(at)

    return {
      /** `Oct 20 · 10:03–10:16`: the date once, or each day for a visit across midnight. */
      range(startedAt: string, lastSeenAt: string): string {
        const start = new Date(startedAt)
        const end = new Date(lastSeenAt)
        const from = clock.format(start)
        const to = clock.format(end)

        if (utcDay(start) !== utcDay(end)) {
          return `${date(start)} ${from} – ${date(end)} ${to}`
        }
        return `${date(start)} · ${from === to ? from : `${from}–${to}`}`
      },
      /** A time within a visit: the clock alone, with the date once it is another day. */
      timeIn(startedAt: string, at: string): string {
        const time = new Date(at)
        const sameDay = utcDay(new Date(startedAt)) === utcDay(time)
        return sameDay ? clockWithSeconds.format(time) : `${date(time)} ${clock.format(time)}`
      },
      /** One moment on its own: `Oct 20 · 10:03`. */
      at(value: string): string {
        const time = new Date(value)
        return `${date(time)} · ${clock.format(time)}`
      },
    }
  }, [locale])
}
