import { describe, expect, test } from "bun:test"
import type { SandboxRequestCredential, SandboxSourceCredentials } from "@sixb/core"
import { WorkspaceAuthSession } from "../src/workspace-auth"

function grant(token: string, lifetime = 3_600_000) {
  let revocations = 0
  const value: SandboxSourceCredentials = {
    requests: [
      {
        origin: "https://github.com",
        path: "/acme/repo.git/info/refs",
        method: "GET",
        headers: { Authorization: token },
      },
    ],
    expiresAt: new Date(Date.now() + lifetime),
    revoke: async () => {
      revocations++
    },
  }
  return { value, revocations: () => revocations }
}

function fixture(authorize: () => Promise<SandboxSourceCredentials>) {
  const controller = new AbortController()
  const updates: (readonly SandboxRequestCredential[])[] = []
  const failures: Error[] = []
  let owner = true
  const auth = new WorkspaceAuthSession({
    auth: { authorize },
    source: { type: "git", url: "https://github.com/acme/repo.git" },
    signal: controller.signal,
    assertOwner: async () => {
      if (!owner) throw new Error("lost")
    },
    onFailure: (error) => {
      failures.push(error)
      controller.abort(error)
    },
  })
  return {
    auth,
    start: async () => {
      updates.push(await auth.prepare())
      auth.attach({
        setRequestCredentials: async (value) => {
          updates.push(value)
        },
      })
    },
    updates,
    failures,
    controller,
    loseOwnership: () => {
      owner = false
    },
  }
}

describe("workspace auth lifecycle", () => {
  test("injects before use, removes access and revokes once on close", async () => {
    const token = grant("secret")
    const f = fixture(async () => token.value)
    await f.start()
    expect(f.updates).toEqual([token.value.requests])
    await f.auth.close()
    await f.auth.close()
    expect(f.updates).toEqual([token.value.requests, []])
    expect(token.revocations()).toBe(1)
  })

  test("renews before expiry and revokes the previous grant", async () => {
    const old = grant("old", 61_000)
    const fresh = grant("new")
    let calls = 0
    let renewed!: () => void
    const renewal = new Promise<void>((resolve) => {
      renewed = resolve
    })
    const originalRevoke = old.value.revoke
    old.value.revoke = async () => {
      await originalRevoke()
      renewed()
    }
    const f = fixture(async () => (++calls === 1 ? old.value : fresh.value))
    try {
      await f.start()
      await renewal
      expect(f.updates).toEqual([old.value.requests, fresh.value.requests])
      expect(old.revocations()).toBe(1)
    } finally {
      await f.auth.close()
    }
    expect(fresh.revocations()).toBe(1)
  })

  test("a failed renewal interrupts the run and cleanup cannot report success", async () => {
    const old = grant("old", 61_000)
    let calls = 0
    const f = fixture(async () => {
      if (++calls > 1) throw new Error("raw provider secret")
      return old.value
    })
    const failed = new Promise<void>((resolve) =>
      f.controller.signal.addEventListener("abort", () => resolve(), { once: true })
    )
    await f.start()
    await failed
    await expect(f.auth.close()).rejects.toThrow("authentication could not be confirmed")
    expect(f.failures[0]?.message).not.toContain("raw provider secret")
    expect(f.updates.at(-1)).toEqual([])
    expect(old.revocations()).toBeGreaterThan(0)
  })

  test("an aborted, late issuance is revoked without injection", async () => {
    const token = grant("late")
    let resolve!: (value: SandboxSourceCredentials) => void
    let issued!: () => void
    const pending = new Promise<SandboxSourceCredentials>((done) => {
      resolve = done
    })
    const started = new Promise<void>((done) => {
      issued = done
    })
    const f = fixture(() => {
      issued()
      return pending
    })
    const start = f.auth.prepare()
    await started
    f.controller.abort()
    resolve(token.value)
    await expect(start).rejects.toThrow("authentication could not be confirmed")
    await f.auth.close()
    expect(f.updates).toEqual([])
    expect(token.revocations()).toBe(1)
  })

  test("lost ownership revokes the token without changing the sandbox policy", async () => {
    const token = grant("owned")
    const f = fixture(async () => token.value)
    await f.start()
    f.loseOwnership()
    f.controller.abort()
    await expect(f.auth.close()).rejects.toThrow("authentication could not be confirmed")
    expect(f.updates).toHaveLength(1)
    expect(token.revocations()).toBeGreaterThan(0)
  })

  test("rejects a session that cannot renew initial credentials", async () => {
    const token = grant("unsupported")
    const f = fixture(async () => token.value)
    await f.auth.prepare()
    expect(() => f.auth.attach({})).toThrow("secure credential injection")
    await f.auth.close()
    expect(token.revocations()).toBe(1)
  })

  test("aborts initialization before credentials expire without a session handle", async () => {
    // Regression proof: remove the unattached timer guard; this never signals failure.
    const token = grant("initial", 60_100)
    const f = fixture(async () => token.value)
    const failed = new Promise<void>((resolve) =>
      f.controller.signal.addEventListener("abort", () => resolve(), { once: true })
    )
    await f.auth.prepare()
    await failed
    await expect(f.auth.close()).rejects.toThrow("authentication could not be confirmed")
    expect(f.updates).toEqual([])
    expect(token.revocations()).toBe(1)
  })
})
