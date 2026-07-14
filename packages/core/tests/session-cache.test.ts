import { describe, expect, test } from "bun:test"
import { SessionCache } from "../src/auth/session-cache"
import type { AuthenticatedAuthSession } from "../src/auth/types"

function fakeSession(id: string): AuthenticatedAuthSession {
  return {
    authenticated: true,
    principal: { type: "user", id },
    user: { id, projectId: "p", email: `${id}@acme.com` },
    session: { id: `ses_${id}` },
    groupIds: [],
  } as unknown as AuthenticatedAuthSession
}

const base = {
  sessionId: "ses_1",
  tokenHash: "hash_1",
  audience: "atlas",
} as const

describe("SessionCache", () => {
  test("returns undefined on miss, hit after set within ttl", () => {
    const cache = new SessionCache(5_000)
    const session = fakeSession("usr_1")

    expect(cache.get({ ...base, nowMs: 0 })).toBeUndefined()
    cache.set({ ...base, session, nowMs: 0, sessionExpiresAtMs: 1_000_000 })
    expect(cache.get({ ...base, nowMs: 4_999 })).toBe(session)
  })

  test("expires entries after ttl", () => {
    const cache = new SessionCache(5_000)
    cache.set({ ...base, session: fakeSession("usr_1"), nowMs: 0, sessionExpiresAtMs: 1_000_000 })

    expect(cache.get({ ...base, nowMs: 5_000 })).toBeUndefined()
    // Expired read evicts the entry.
    expect(cache.get({ ...base, nowMs: 1 })).toBeUndefined()
  })

  test("never serves a cached session past its real expiry", () => {
    const cache = new SessionCache(60_000)
    // Session expires at 2s even though ttl is 60s.
    cache.set({ ...base, session: fakeSession("usr_1"), nowMs: 0, sessionExpiresAtMs: 2_000 })

    expect(cache.get({ ...base, nowMs: 1_999 })).toBeDefined()
    expect(cache.get({ ...base, nowMs: 2_000 })).toBeUndefined()
  })

  test("never serves a cached session past its absolute expiry", () => {
    const cache = new SessionCache(60_000)
    cache.set({
      ...base,
      session: fakeSession("usr_1"),
      nowMs: 0,
      sessionExpiresAtMs: 50_000,
      sessionAbsoluteExpiresAtMs: 2_000,
    })

    expect(cache.get({ ...base, nowMs: 1_999 })).toBeDefined()
    expect(cache.get({ ...base, nowMs: 2_000 })).toBeUndefined()
  })

  test("does not store an already-expired session", () => {
    const cache = new SessionCache(5_000)
    cache.set({ ...base, session: fakeSession("usr_1"), nowMs: 10_000, sessionExpiresAtMs: 9_000 })
    expect(cache.get({ ...base, nowMs: 10_000 })).toBeUndefined()
  })

  test("is bound to the exact token hash and audience", () => {
    const cache = new SessionCache(5_000)
    cache.set({ ...base, session: fakeSession("usr_1"), nowMs: 0, sessionExpiresAtMs: 1_000_000 })

    expect(cache.get({ ...base, tokenHash: "other", nowMs: 1 })).toBeUndefined()
    cache.set({ ...base, session: fakeSession("usr_1"), nowMs: 0, sessionExpiresAtMs: 1_000_000 })
    expect(cache.get({ ...base, audience: "app", nowMs: 1 })).toBeUndefined()
  })

  test("invalidate and clear drop entries", () => {
    const cache = new SessionCache(5_000)
    cache.set({ ...base, session: fakeSession("usr_1"), nowMs: 0, sessionExpiresAtMs: 1_000_000 })
    cache.invalidate("ses_1")
    expect(cache.get({ ...base, nowMs: 1 })).toBeUndefined()

    cache.set({ ...base, session: fakeSession("usr_1"), nowMs: 0, sessionExpiresAtMs: 1_000_000 })
    cache.clear()
    expect(cache.get({ ...base, nowMs: 1 })).toBeUndefined()
  })

  test("evicts the oldest entry past maxEntries", () => {
    const cache = new SessionCache(5_000, 2)
    const mk = (id: string) => ({
      sessionId: id,
      tokenHash: `h_${id}`,
      audience: "atlas" as const,
      session: fakeSession(id),
      nowMs: 0,
      sessionExpiresAtMs: 1_000_000,
    })
    cache.set(mk("a"))
    cache.set(mk("b"))
    cache.set(mk("c")) // evicts "a" (oldest)

    expect(
      cache.get({ sessionId: "a", tokenHash: "h_a", audience: "atlas", nowMs: 1 })
    ).toBeUndefined()
    expect(
      cache.get({ sessionId: "b", tokenHash: "h_b", audience: "atlas", nowMs: 1 })
    ).toBeDefined()
    expect(
      cache.get({ sessionId: "c", tokenHash: "h_c", audience: "atlas", nowMs: 1 })
    ).toBeDefined()
  })
})
