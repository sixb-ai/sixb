const minuteMs = 60_000
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs

export interface ScenarioClock {
  readonly anchor: Date
  minutesAgo(value: number): string
  minutesFromNow(value: number): string
  hoursAgo(value: number): string
  hoursFromNow(value: number): string
  daysAgo(value: number): string
  daysFromNow(value: number): string
  dateDaysAgo(value: number): string
  dateDaysFromNow(value: number): string
}

export function createScenarioClock(anchor = new Date()): ScenarioClock {
  const roundedAnchor = new Date(Math.floor(anchor.getTime() / minuteMs) * minuteMs)
  const iso = (offset: number) => new Date(roundedAnchor.getTime() + offset).toISOString()
  const date = (offset: number) => iso(offset).slice(0, 10)

  return {
    anchor: roundedAnchor,
    minutesAgo: (value) => iso(-value * minuteMs),
    minutesFromNow: (value) => iso(value * minuteMs),
    hoursAgo: (value) => iso(-value * hourMs),
    hoursFromNow: (value) => iso(value * hourMs),
    daysAgo: (value) => iso(-value * dayMs),
    daysFromNow: (value) => iso(value * dayMs),
    dateDaysAgo: (value) => date(-value * dayMs),
    dateDaysFromNow: (value) => date(value * dayMs),
  }
}
