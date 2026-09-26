import { isIPv4 } from "node:net"

/**
 * Fixed-window request limit per client address, held in process memory.
 *
 * IPv6 addresses share one window per /64, the block a single host is usually assigned.
 * Windows all have the same length, so insertion order is expiry order and pruning stops at the
 * first live window.
 */
export class ClientAddressRateLimiter {
  private readonly windows = new Map<string, { count: number; readonly resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  tryConsume(address: string | undefined, nowMs = Date.now()): boolean {
    for (const [key, window] of this.windows) {
      if (window.resetAt > nowMs) break
      this.windows.delete(key)
    }

    const key = rateLimitKey(address)
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

function rateLimitKey(address: string | undefined): string {
  if (!address || isIPv4(address)) return address ?? ""
  const [head = "", tail = ""] = address.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0")
  return `${[...left, ...zeros, ...right].slice(0, 4).join(":")}::/64`
}
