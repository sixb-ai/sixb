import { describe, expect, test } from "bun:test"
import type { AgentWorkspaceCredentials, SandboxRequestCredential } from "@sixb/core"
import { WorkspaceAuthSession } from "../src/workspace-auth"

function grant(token: string, lifetime = 3_600_000) {
  let revocations = 0
  const value: AgentWorkspaceCredentials = {
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

function fixture(authorize: () => Promise<AgentWorkspaceCredentials>) {
  const controller = new AbortController()
  const updates: (readonly SandboxRequestCredential[])[] = []
  const failures: Error[] = []
  let owner = true
  const auth = new WorkspaceAuthSession({
    auth: { authorize },
    source: { type: "git", url: "https://github.com/acme/repo.git" },
    sandbox: {
      setRequestCredentials: async (value) => {
        updates.push(value)
      },
    },
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
    await f.auth.start()
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
      await f.auth.start()
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
    await f.auth.start()
    await failed
    await expect(f.auth.close()).rejects.toThrow("authentication could not be confirmed")
    expect(f.failures[0]?.message).not.toContain("raw provider secret")
    expect(f.updates.at(-1)).toEqual([])
    expect(old.revocations()).toBeGreaterThan(0)
  })

  test("an aborted, late issuance is revoked without injection", async () => {
    const token = grant("late")
    let resolve!: (value: AgentWorkspaceCredentials) => void
    let issued!: () => void
    const pending = new Promise<AgentWorkspaceCredentials>((done) => {
      resolve = done
    })
    const started = new Promise<void>((done) => {
      issued = done
    })
    const f = fixture(() => {
      issued()
      return pending
    })
    const start = f.auth.start()
    await started
    f.controller.abort()
    resolve(token.value)
    await start
    await f.auth.close()
    expect(f.updates).toEqual([[]])
    expect(token.revocations()).toBe(1)
  })

  test("lost ownership revokes the token without changing the sandbox policy", async () => {
    const token = grant("owned")
    const f = fixture(async () => token.value)
    await f.auth.start()
    f.loseOwnership()
    f.controller.abort()
    await expect(f.auth.close()).rejects.toThrow("authentication could not be confirmed")
    expect(f.updates).toHaveLength(1)
    expect(token.revocations()).toBeGreaterThan(0)
  })

  test("rejects a provider without secure injection before issuing a token", () => {
    let called = false
    expect(
      () =>
        new WorkspaceAuthSession({
          auth: {
            authorize: async () => {
              called = true
              return grant("never").value
            },
          },
          source: { type: "git", url: "https://github.com/acme/repo.git" },
          sandbox: {},
          signal: new AbortController().signal,
          assertOwner: async () => {},
          onFailure: () => {},
        })
    ).toThrow("secure credential injection")
    expect(called).toBe(false)
  })
})
