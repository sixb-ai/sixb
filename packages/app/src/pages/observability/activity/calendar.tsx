import { getActivityCalendar } from "@sixb/client"
import { Button } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react"
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { PageSection, Panel, PanelEmpty, PanelSkeleton } from "../../section-ui"
import { useActivityMessages } from "./messages"
import { activityQueryKey, activityYearGrid, utcDay } from "./period"

// No activity, then four shades of the day's page views relative to the year's busiest day.
const intensityClasses = [
  "bg-muted",
  "bg-emerald-500/30",
  "bg-emerald-500/55",
  "bg-emerald-500/80",
  "bg-emerald-600 dark:bg-emerald-400",
] as const

/**
 * The shade of a day. A day with visits but no page view (activity on a page opened the day
 * before) still reads as active, in the lightest shade.
 */
function intensity(pageViews: number | undefined, active: boolean, busiest: number): number {
  if (!active) {
    return 0
  }
  if (!pageViews || busiest === 0) {
    return 1
  }
  return Math.max(1, Math.ceil((pageViews / busiest) * 4))
}

// Arrow keys move a week sideways and a day up or down, as the grid is laid out.
const keySteps: Readonly<Record<string, number>> = {
  ArrowLeft: -7,
  ArrowRight: 7,
  ArrowUp: -1,
  ArrowDown: 1,
}

/** One user's active days in a UTC year, GitHub-style. A day opens its visits. */
export function ActivityCalendar({
  userId,
  year,
  selectedDay,
  onYear,
  onDay,
}: {
  readonly userId: string
  readonly year: number
  readonly selectedDay: string | undefined
  readonly onYear: (year: number) => void
  readonly onDay: (day: string) => void
}) {
  const messages = useActivityMessages().calendar
  const locale = useLocale()
  const [focusedDay, setFocusedDay] = useState<string>()
  const query = useQuery({
    queryKey: [...activityQueryKey, "calendar", userId, year],
    queryFn: async ({ signal }) =>
      (await getActivityCalendar({ query: { userId, year }, signal, throwOnError: true })).data,
    retry: false,
  })

  const today = utcDay(Date.now())
  const currentYear = new Date().getUTCFullYear()
  const cells = useMemo(() => activityYearGrid(year), [year])
  const weeks = cells.length / 7
  const days = new Map(query.data?.days.map((day) => [day.day, day]))
  const busiest = Math.max(0, ...(query.data?.days.map((day) => day.pageViews) ?? []))

  const formatDate = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" })
  const formatMonth = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" })
  const formatWeekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })

  // One day takes the keyboard's focus: the last one touched, the chosen one, or the latest.
  const tabbableDay =
    [focusedDay, selectedDay, query.data?.days.at(-1)?.day].find((day) =>
      day?.startsWith(`${year}-`)
    ) ?? (year === currentYear ? today : `${year}-01-01`)

  // A narrow screen scrolls the year sideways: open it on the day that matters, not on January.
  const scroller = useRef<HTMLDivElement>(null)
  const loaded = query.isSuccess
  useEffect(() => {
    const container = scroller.current
    const cell = container?.querySelector(`button[data-day="${tabbableDay}"]`)
    if (!loaded || !container || !cell) {
      return
    }

    const offset = cell.getBoundingClientRect().left - container.getBoundingClientRect().left
    container.scrollLeft += offset - container.clientWidth / 2
  }, [loaded, tabbableDay])

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = keySteps[event.key]
    if (step === undefined) {
      return
    }

    event.preventDefault()
    const destination = cells[index + step]
    if (destination && destination <= today) {
      event.currentTarget.parentElement
        ?.querySelector<HTMLButtonElement>(`button[data-day="${destination}"]`)
        ?.focus()
    }
  }

  return (
    <PageSection
      title={messages.title}
      description={query.data ? messages.activeDays(query.data.days.length) : messages.hint}
      action={
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={messages.previousYear}
            disabled={year <= 1970}
            onClick={() => onYear(year - 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-10 text-center text-[0.8125rem] tabular-nums">{year}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={messages.nextYear}
            disabled={year >= currentYear}
            onClick={() => onYear(year + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      }
    >
      <Panel footer={messages.hint}>
        {query.isPending ? (
          <PanelSkeleton rows={2} />
        ) : query.isError ? (
          <PanelEmpty tone="error" icon={CalendarDays} title={messages.unavailable} />
        ) : (
          <div ref={scroller} className="overflow-x-auto px-4 py-4">
            <div className="min-w-[720px]">
              <div
                aria-hidden
                className="mb-1 ml-9 grid h-4 text-[0.6875rem] text-muted-foreground"
                style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
              >
                {cells.flatMap((day, index) =>
                  day?.endsWith("-01") ? (
                    <span key={day} style={{ gridColumn: Math.floor(index / 7) + 1 }}>
                      {formatMonth.format(new Date(`${day}T00:00:00Z`))}
                    </span>
                  ) : (
                    []
                  )
                )}
              </div>

              <div className="flex gap-2">
                <div
                  aria-hidden
                  className="grid w-7 shrink-0 grid-rows-7 gap-[3px] text-[0.6875rem] leading-none text-muted-foreground"
                >
                  {/* 1970-01-04 was a Sunday. */}
                  {Array.from({ length: 7 }, (_, index) => (
                    <span key={index} className="flex items-center">
                      {index % 2 ? formatWeekday.format(Date.UTC(1970, 0, 4 + index)) : ""}
                    </span>
                  ))}
                </div>

                <div
                  className="grid flex-1 grid-flow-col grid-rows-7 gap-[3px]"
                  style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
                >
                  {cells.map((day, index) => {
                    if (!day) {
                      return <span key={`blank-${index}`} />
                    }

                    const counts = days.get(day)
                    const label = messages.dayLabel(
                      formatDate.format(new Date(`${day}T00:00:00Z`)),
                      counts?.visits ?? 0,
                      counts?.pageViews ?? 0
                    )
                    return (
                      <button
                        key={day}
                        type="button"
                        data-day={day}
                        title={label}
                        aria-label={label}
                        aria-pressed={day === selectedDay}
                        tabIndex={day === tabbableDay ? 0 : -1}
                        disabled={day > today}
                        onFocus={() => setFocusedDay(day)}
                        onKeyDown={(event) => moveFocus(event, index)}
                        onClick={() => onDay(day)}
                        className={cn(
                          "aspect-square min-h-3 rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30",
                          intensityClasses[
                            intensity(counts?.pageViews, counts !== undefined, busiest)
                          ],
                          day === selectedDay
                            ? "ring-2 ring-foreground ring-offset-1 ring-offset-card"
                            : "hover:ring-1 hover:ring-foreground/40"
                        )}
                      />
                    )
                  })}
                </div>
              </div>
            </div>

            <div
              className="mt-3 flex items-center justify-end gap-1 text-xs text-muted-foreground"
              title={messages.intensity}
            >
              <span className="mr-1">{messages.less}</span>
              {intensityClasses.map((shade) => (
                <span key={shade} aria-hidden className={cn("size-2.5 rounded-[3px]", shade)} />
              ))}
              <span className="ml-1">{messages.more}</span>
            </div>
          </div>
        )}
      </Panel>
    </PageSection>
  )
}
