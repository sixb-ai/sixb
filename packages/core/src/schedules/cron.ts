import { SixbError } from "../errors"

export interface CronFieldMatcher {
  readonly isAny: boolean
  readonly values: ReadonlySet<number> | null
  matches(value: number): boolean
}

function parseInteger(input: string, fieldName: string): number {
  if (!/^\d+$/.test(input)) {
    throw new SixbError("runtime.invalid_definition", `Invalid ${fieldName}: '${input}'.`)
  }

  return Number.parseInt(input, 10)
}

export function createCronFieldMatcher(params: {
  field: string
  min: number
  max: number
  fieldName: string
  normalize?: (value: number) => number
}): CronFieldMatcher {
  const { field, min, max, fieldName } = params
  const normalize = params.normalize ?? ((value: number) => value)
  const input = field.trim()

  if (!input) {
    throw new SixbError("runtime.invalid_definition", `Empty cron ${fieldName} field.`)
  }

  if (input === "*") {
    return {
      isAny: true,
      values: null,
      matches: () => true,
    }
  }

  const allowed = new Set<number>()
  const segments = input.split(",")

  for (const segment of segments) {
    if (!segment) {
      throw new SixbError(
        "runtime.invalid_definition",
        `Invalid cron ${fieldName} field: '${input}'.`
      )
    }

    const stepParts = segment.split("/")
    if (stepParts.length > 2) {
      throw new SixbError(
        "runtime.invalid_definition",
        `Invalid cron ${fieldName} segment: '${segment}'.`
      )
    }

    const base = stepParts[0]
    const step =
      stepParts[1] === undefined
        ? 1
        : parseInteger(stepParts[1], `cron ${fieldName} step for '${segment}'`)

    if (step <= 0) {
      throw new SixbError(
        "runtime.invalid_definition",
        `Cron ${fieldName} step must be > 0 in segment '${segment}'.`
      )
    }

    let rangeStart: number
    let rangeEnd: number

    if (base === "*") {
      rangeStart = min
      rangeEnd = max
    } else if (base.includes("-")) {
      const [rawStart, rawEnd] = base.split("-")
      if (!rawStart || !rawEnd) {
        throw new SixbError(
          "runtime.invalid_definition",
          `Invalid cron ${fieldName} range: '${base}'.`
        )
      }

      rangeStart = parseInteger(rawStart, `cron ${fieldName} range start for '${base}'`)
      rangeEnd = parseInteger(rawEnd, `cron ${fieldName} range end for '${base}'`)
    } else {
      const value = parseInteger(base, `cron ${fieldName} value '${base}'`)
      rangeStart = value
      rangeEnd = value
    }

    if (rangeStart > rangeEnd) {
      throw new SixbError(
        "runtime.invalid_definition",
        `Cron ${fieldName} range start must be <= end in segment '${segment}'.`
      )
    }

    for (let value = rangeStart; value <= rangeEnd; value += step) {
      const normalized = normalize(value)
      if (normalized < min || normalized > max) {
        throw new SixbError(
          "runtime.invalid_definition",
          `Cron ${fieldName} value ${value} is outside range ${min}-${max}.`
        )
      }
      allowed.add(normalized)
    }
  }

  return {
    isAny: false,
    values: allowed,
    matches(value: number) {
      const normalized = normalize(value)
      return allowed.has(normalized)
    },
  }
}

export function createCronMatcher(expression: string): (now: Date) => boolean {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Invalid cron expression '${expression}'. Expected 5 fields (minute hour day month weekday).`
    )
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts

  const minute = createCronFieldMatcher({
    field: minuteField,
    min: 0,
    max: 59,
    fieldName: "minute",
  })
  const hour = createCronFieldMatcher({
    field: hourField,
    min: 0,
    max: 23,
    fieldName: "hour",
  })
  const dayOfMonth = createCronFieldMatcher({
    field: dayOfMonthField,
    min: 1,
    max: 31,
    fieldName: "day-of-month",
  })
  const month = createCronFieldMatcher({
    field: monthField,
    min: 1,
    max: 12,
    fieldName: "month",
  })
  const dayOfWeek = createCronFieldMatcher({
    field: dayOfWeekField,
    min: 0,
    max: 6,
    fieldName: "day-of-week",
    normalize: (value) => (value === 7 ? 0 : value),
  })

  return (now: Date) => {
    if (!minute.matches(now.getMinutes())) return false
    if (!hour.matches(now.getHours())) return false
    if (!month.matches(now.getMonth() + 1)) return false

    const dayOfMonthMatches = dayOfMonth.matches(now.getDate())
    const dayOfWeekMatches = dayOfWeek.matches(now.getDay())
    const dayMatches =
      dayOfMonth.isAny || dayOfWeek.isAny
        ? dayOfMonthMatches && dayOfWeekMatches
        : dayOfMonthMatches || dayOfWeekMatches

    return dayMatches
  }
}
