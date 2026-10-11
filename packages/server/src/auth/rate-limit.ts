import { isIPv4 } from "node:net"

/**
 * Fixed-window request limit per key, held in process memory.
 *
 * Windows all have the same length, so insertion order is expiry order and pruning stops at the
 * first live window.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; readonly resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  tryConsume(key: string, nowMs = Date.now()): boolean {
    for (const [expired, window] of this.windows) {
      if (window.resetAt > nowMs) break
      this.windows.delete(expired)
    }

    const window = this.windows.get(key)
    if (!window) {
      this.windows.set(key, { count: 1, resetAt: nowMs + this.windowMs })
      return true
    }
    if (window.count >= this.limit) return false
    window.count += 1
    return true
  }
}

/**
 * Fixed-window request limit per client address. IPv6 addresses share one window per /64, the
 * block a single host is usually assigned.
 */
export class ClientAddressRateLimiter {
  private readonly limiter: FixedWindowRateLimiter

  constructor(limit: number, windowMs: number) {
    this.limiter = new FixedWindowRateLimiter(limit, windowMs)
  }

  tryConsume(address: string | undefined, nowMs = Date.now()): boolean {
    return this.limiter.tryConsume(rateLimitKey(address), nowMs)
  }
}

function rateLimitKey(address: string | undefined): string {
  if (!address || isIPv4(address)) return address ?? ""
  const [head = "", tail = ""] = address.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0")
  return `${[...left, ...zeros, ...right].slice(0, 4).join(":")}::/64`
}
