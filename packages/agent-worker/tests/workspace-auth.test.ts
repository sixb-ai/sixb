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
      updates.push((await auth.prepare()).requests)
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

  test("returns a snapshot of the first grant's guest environment", async () => {
    const env: Record<string, string> = { GIT_AUTHOR_NAME: "Integration" }
    const token = grant("identity")
    const f = fixture(async () => ({ ...token.value, env }))

    const prepared = await f.auth.prepare()
    env.GIT_AUTHOR_NAME = "Mutated"

    expect(prepared.env).toEqual({ GIT_AUTHOR_NAME: "Integration" })
    await f.auth.close()
  })

  test("defaults to an empty guest environment", async () => {
    const f = fixture(async () => grant("no-env").value)

    expect((await f.auth.prepare()).env).toEqual({})
    await f.auth.close()
  })

  test.each([
    { "": "empty key" },
    { "GIT=NAME": "separator in key" },
    { "GIT\0NAME": "NUL in key" },
    { GIT_AUTHOR_NAME: "NUL\0in value" },
    { GIT_AUTHOR_NAME: 1 },
  ])("rejects an invalid guest environment and revokes its grant: %j", async (env) => {
    // Regression proof: replace captureSandboxEnv(grant.env) with grant.env; prepare resolves.
    const token = grant("invalid-env")
    const f = fixture(async () => ({
      ...token.value,
      env: env as unknown as Record<string, string>,
    }))

    await expect(f.auth.prepare()).rejects.toThrow("authentication could not be confirmed")
    await expect(f.auth.close()).rejects.toThrow("authentication could not be confirmed")

    expect(f.updates).toEqual([])
    expect(token.revocations()).toBe(1)
  })

  test.each([
    "https://*",
    "https://*.github.com",
    "https://github.com/acme",
    "http://github.com",
  ])("rejects a request origin that is not one exact host, and revokes its grant: %p", async (origin) => {
    // Regression proof: drop the isSingleHostOrigin check in refresh(); prepare resolves and
    // the run's network opens the origin as issued.
    const token = grant("wildcard")
    const [request] = token.value.requests
    const f = fixture(async () => ({ ...token.value, requests: [{ ...request!, origin }] }))

    await expect(f.auth.prepare()).rejects.toThrow("authentication could not be confirmed")
    await expect(f.auth.close()).rejects.toThrow("authentication could not be confirmed")

    expect(f.updates).toEqual([])
    expect(token.revocations()).toBe(1)
  })

  test("ignores the guest environment of a renewal", async () => {
    // Regression proof: validate every grant's env; the invalid renewal env interrupts the session.
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
    const f = fixture(
      async (): Promise<SandboxSourceCredentials> =>
        ++calls === 1
          ? { ...old.value, env: { GIT_AUTHOR_NAME: "Integration" } }
          : { ...fresh.value, env: { "INVALID=KEY": "ignored" } }
    )

    try {
      await f.start()
      await renewal

      expect(f.updates).toEqual([old.value.requests, fresh.value.requests])
      expect(f.failures).toEqual([])
    } finally {
      await f.auth.close()
    }
    expect(fresh.revocations()).toBe(1)
  })

  test("keeps the integration's error as the cause behind the generic message", async () => {
    // Regression proof: catch without binding in refresh() and throw authError(); no cause remains.
    const integration = new Error(
      "[SixbGitHub] The App installation does not grant the permissions."
    )
    const f = fixture(async () => {
      throw integration
    })

    const failure = await f.auth.prepare().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: "[SixbAgentWorker] Workspace authentication could not be confirmed.",
      cause: integration,
    })
    await expect(f.auth.close()).rejects.toThrow("authentication could not be confirmed")
  })

  test("reports a failed renewal with the integration's error in its cause chain", async () => {
    // Regression proof: drop the error from the renewal catch; the chain ends before it.
    const old = grant("old", 61_000)
    const integration = new Error("[SixbGitHub] Workspace authentication failed (HTTP 503).")
    let calls = 0
    const f = fixture(async () => {
      if (++calls > 1) throw integration
      return old.value
    })
    const failed = new Promise<void>((resolve) =>
      f.controller.signal.addEventListener("abort", () => resolve(), { once: true })
    )

    await f.start()
    await failed

    expect(f.failures[0]?.message).toBe(
      "[SixbAgentWorker] Workspace authentication could not be confirmed."
    )
    expect(causes(f.failures[0])).toContain(integration)
    await expect(f.auth.close()).rejects.toThrow("authentication could not be confirmed")
  })
})

function causes(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current = error instanceof Error ? error.cause : undefined

  while (current !== undefined) {
    chain.push(current)
    current = current instanceof Error ? current.cause : undefined
  }

  return chain
}
