const DATASET_TIMESTAMP =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?([zZ]|[+-]\d{2}:?\d{2})?$/

interface TimestampComponents {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly milliseconds: number
}

/** Parses a projection dataset timestamp, interpreting zone-less values as UTC. */
export function parseDatasetTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== "string") return null

  const match = DATASET_TIMESTAMP.exec(value.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second, fraction, zone] = match
  const offsetMinutes = parseZoneOffsetMinutes(zone)
  if (offsetMinutes === null) return null

  const components: TimestampComponents = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: hour === undefined ? 0 : Number(hour),
    minute: minute === undefined ? 0 : Number(minute),
    second: second === undefined ? 0 : Number(second),
    milliseconds: fraction === undefined ? 0 : Math.trunc(Number(`0.${fraction}`) * 1000),
  }
  const wallClock = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second,
    components.milliseconds
  )
  if (!wallClockMatchesComponents(wallClock, components)) return null
  return new Date(wallClock - offsetMinutes * 60_000)
}

function parseZoneOffsetMinutes(zone: string | undefined): number | null {
  if (zone === undefined || zone === "Z" || zone === "z") return 0
  const digits = zone.slice(1).replace(":", "")
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2, 4))
  if (hours > 23 || minutes > 59) return null
  return (zone[0] === "-" ? -1 : 1) * (hours * 60 + minutes)
}

function wallClockMatchesComponents(wallClock: number, components: TimestampComponents): boolean {
  const date = new Date(wallClock)
  return (
    date.getUTCFullYear() === components.year &&
    date.getUTCMonth() === components.month - 1 &&
    date.getUTCDate() === components.day &&
    date.getUTCHours() === components.hour &&
    date.getUTCMinutes() === components.minute &&
    date.getUTCSeconds() === components.second
  )
}
