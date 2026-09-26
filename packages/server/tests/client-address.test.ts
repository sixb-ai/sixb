import { describe, expect, test } from "bun:test"
import { createClientAddressResolver, PRIVATE_NETWORKS } from "../src/auth/client-address"
import { ClientAddressRateLimiter } from "../src/auth/rate-limit"

describe("client address", () => {
  const resolve = createClientAddressResolver([PRIVATE_NETWORKS])

  test("ignores forwarding headers from a peer that is not a trusted proxy", () => {
    expect(resolve("198.51.100.9", "203.0.113.7")).toBe("198.51.100.9")
  })

  test("reads the entry a trusted proxy appended, not the ones a client wrote", () => {
    expect(resolve("127.0.0.1", "203.0.113.7")).toBe("203.0.113.7")
    expect(resolve("127.0.0.1", "1.2.3.4, 203.0.113.7")).toBe("203.0.113.7")
    expect(resolve("10.0.0.5", "1.2.3.4, 203.0.113.7, 192.168.1.2")).toBe("203.0.113.7")
  })

  test("normalizes IPv4-mapped peers from dual-stack listeners", () => {
    expect(resolve("::ffff:198.51.100.9", null)).toBe("198.51.100.9")
    expect(resolve("::FFFF:127.0.0.1", "2001:DB8::1")).toBe("2001:db8::1")
  })

  test("stops at a malformed entry", () => {
    expect(resolve("127.0.0.1", "203.0.113.7, unknown")).toBe("127.0.0.1")
  })

  test("trusts only the configured proxies", () => {
    const behindCdn = createClientAddressResolver([PRIVATE_NETWORKS, "173.245.48.0/20"])
    expect(behindCdn("127.0.0.1", "203.0.113.7, 173.245.48.1")).toBe("203.0.113.7")
    expect(resolve("127.0.0.1", "203.0.113.7, 173.245.48.1")).toBe("173.245.48.1")
    expect(createClientAddressResolver([])("127.0.0.1", "203.0.113.7")).toBe("127.0.0.1")
  })

  test("rejects entries that are not addresses or ranges", () => {
    for (const entry of ["proxy.internal", "10.0.0.0/33", "10.0.0.0/", "10.0.0.0/8/8", "::1/129"]) {
      expect(() => createClientAddressResolver([entry])).toThrow(`Trusted proxy '${entry}'`)
    }
  })
})

describe("client address rate limit", () => {
  test("limits each address within a window", () => {
    const limiter = new ClientAddressRateLimiter(2, 1_000)
    expect(limiter.tryConsume("203.0.113.7", 0)).toBe(true)
    expect(limiter.tryConsume("203.0.113.7", 1)).toBe(true)
    expect(limiter.tryConsume("203.0.113.7", 2)).toBe(false)
    expect(limiter.tryConsume("203.0.113.8", 2)).toBe(true)
    expect(limiter.tryConsume("203.0.113.7", 1_000)).toBe(true)
  })

  test("shares one window across an IPv6 /64", () => {
    const limiter = new ClientAddressRateLimiter(1, 1_000)
    expect(limiter.tryConsume("2001:db8:1:2::1", 0)).toBe(true)
    expect(limiter.tryConsume("2001:db8:1:2:ffff::9", 0)).toBe(false)
    expect(limiter.tryConsume("2001:db8:1:3::1", 0)).toBe(true)
  })
})
