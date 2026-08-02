import { SixbError } from "@sixb/core/errors"
export interface MagicLinkRateLimitOptions {
  readonly perMinute: number
  readonly perHour: number
}

export class MagicLinkRateLimiter {
  private readonly attempts = new Map<string, number[]>()

  constructor(private readonly options: MagicLinkRateLimitOptions | false) {}

  canConsume(key: string, now: Date): boolean {
    if (this.options === false) {
      return true
    }

    const { attempts, minuteAttempts } = this.getRecentAttempts(key, now)
    return attempts.length < this.options.perHour && minuteAttempts.length < this.options.perMinute
  }

  tryConsume(key: string, now: Date): boolean {
    if (this.options === false) {
      return true
    }

    const { attempts, minuteAttempts } = this.getRecentAttempts(key, now)

    if (
      minuteAttempts.length >= this.options.perMinute ||
      attempts.length >= this.options.perHour
    ) {
      this.attempts.set(key, attempts)
      return false
    }

    attempts.push(now.getTime())
    this.attempts.set(key, attempts)
    return true
  }

  private getRecentAttempts(
    key: string,
    now: Date
  ): {
    readonly attempts: number[]
    readonly minuteAttempts: readonly number[]
  } {
    const nowMs = now.getTime()
    const oneMinuteAgo = nowMs - 60_000
    const oneHourAgo = nowMs - 60 * 60_000
    const attempts = (this.attempts.get(key) ?? []).filter((value) => value > oneHourAgo)

    return {
      attempts,
      minuteAttempts: attempts.filter((value) => value > oneMinuteAgo),
    }
  }
}

export function resolveRateLimitOptions(
  options: false | Partial<MagicLinkRateLimitOptions> | undefined
): MagicLinkRateLimitOptions | false {
  if (options === false) {
    return false
  }

  // Defaults accommodate a single user signing into multiple audiences (Atlas and
  // a custom app) in one burst. The limiter is keyed per email and shared across
  // audiences, so the per-minute default must cover the number of browser roles.
  const perMinute = options?.perMinute ?? 5
  const perHour = options?.perHour ?? 20

  if (!Number.isInteger(perMinute) || perMinute <= 0) {
    throw new MagicLinkConfigError("Magic-link auth rateLimit.perMinute must be positive.")
  }

  if (!Number.isInteger(perHour) || perHour <= 0) {
    throw new MagicLinkConfigError("Magic-link auth rateLimit.perHour must be positive.")
  }

  if (perHour < perMinute) {
    throw new MagicLinkConfigError(
      "Magic-link auth rateLimit.perHour must be greater than or equal to perMinute."
    )
  }

  return { perMinute, perHour }
}

class MagicLinkConfigError extends SixbError {
  override readonly name = "MagicLinkConfigError"

  constructor(message: string) {
    super("runtime.invalid_definition", `[Sixb] ${message}`)
  }
}
