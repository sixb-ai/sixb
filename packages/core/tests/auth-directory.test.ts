import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { defineGroup, SixbHost } from "../src"
import { AuthRuntime, type OidcAuthStrategy } from "../src/auth"
import type { AuthStrategyDirectory, DirectoryVerdict } from "../src/auth/strategy"
import { InMemoryAuthStorage } from "../src/storage"
import { createTestRuntimeDeps, waitFor } from "./test-runtime-deps"

const PROJECT_ID = "directory"
const members = defineGroup("members")
const finance = defineGroup("finance")

type Verdicts = Record<string, DirectoryVerdict | undefined>

/** An OIDC strategy whose directory answers from `verdicts`, keyed by subject. */
function strategyWith(
  verdicts: () => Verdicts,
  options: {
    readonly intervalMs?: number
    readonly confirmAfterMs?: number
    readonly fail?: () => boolean
  } = {}
): OidcAuthStrategy & { readonly directory: AuthStrategyDirectory } {
  return {
    id: "entra",
    kind: "oidc",
    async startOidcSignIn(): Promise<never> {
      throw new Error("unused")
    },
    async completeOidcSignIn(): Promise<never> {
      throw new Error("unused")
    },
    async deliverInvitation() {
      return { status: "not_supported" }
    },
    providerProfileFields: () => [],
    directory: {
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      confirmAfterMs: options.confirmAfterMs ?? 0,
      async check({ identities }) {
        if (options.fail?.()) throw new Error("Graph answered 403")
        const answers = new Map<string, DirectoryVerdict>()
        const read = verdicts()
        for (const { subject } of identities) {
          const verdict = read[subject]
          if (verdict) answers.set(subject, verdict)
        }
        return answers
      },
    },
  }
}

/** A project whose members each signed in once with the strategy, as `sub-<name>`. */
async function createProject(
  names: readonly string[],
  verdicts: Verdicts | (() => Verdicts),
  options: { readonly confirmAfterMs?: number; readonly fail?: () => boolean } = {}
) {
  const deps = createTestRuntimeDeps()
  const strategy = strategyWith(typeof verdicts === "function" ? verdicts : () => verdicts, options)
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [],
    ...deps,
    groups: [members, finance],
    auth: strategy,
  })
  const auth = deps.storage.auth
  for (const name of names) {
    await auth.users.create({ id: `usr_${name}`, projectId: PROJECT_ID, email: `${name}@acme.com` })
    await auth.identities.upsert({
      projectId: PROJECT_ID,
      strategyId: "entra",
      subject: `sub-${name}`,
      userId: `usr_${name}`,
      claims: { oid: `oid-${name}` },
    })
    await auth.sessions.create({
      id: `ses_${name}`,
      projectId: PROJECT_ID,
      userId: `usr_${name}`,
      strategyId: "entra",
      tokenHash: `hash-${name}`,
      createdAt: new Date("2026-11-08T10:00:00.000Z"),
      expiresAt: new Date("2099-11-08T10:00:00.000Z"),
    })
  }

  return {
    host,
    auth,
    strategy,
    user: (name: string) => auth.users.getById({ projectId: PROJECT_ID, id: `usr_${name}` }),
    session: (name: string) => auth.sessions.getById({ projectId: PROJECT_ID, id: `ses_${name}` }),
    events: async () =>
      (await host.events.read({ topics: ["users"] })).map(({ type, payload }) => [type, payload]),
    check: () => host.auth.checkDirectory(AbortSignal.timeout(5_000)),
  }
}

// Lets every promise the pass is waiting on run. Under fake timers, nothing else can.
async function settle() {
  for (let turn = 0; turn < 100; turn++) await Promise.resolve()
}

describe("directory check", () => {
  // A fake-timer test that times out never reaches its own cleanup.
  afterEach(() => {
    jest.useRealTimers()
  })

  // Removal proof: return the plan without applying it; Ben stays active.
  test("suspends whoever left, ends their sessions, and says no one asked", async () => {
    const project = await createProject(["ada", "ben"], {
      "sub-ada": { status: "active" },
      "sub-ben": { status: "inactive" },
    })

    await project.check()

    await expect(project.user("ben")).resolves.toMatchObject({
      status: "suspended",
      suspensionSource: "directory",
    })
    await expect(project.session("ben")).resolves.toMatchObject({ revokedAt: expect.any(Date) })
    await expect(project.user("ada")).resolves.toMatchObject({ status: "active" })
    await expect(project.session("ada")).resolves.not.toHaveProperty("revokedAt")
    expect(await project.events()).toEqual([
      ["user.suspended", { user: expect.objectContaining({ id: "usr_ben" }) }],
    ])

    // The next pass has nothing to change, so it writes nothing and says nothing.
    // Removal proof: return every verdict from `planDirectoryPass`; storage is then called twice.
    // The prototype, because `project.auth` is a facade over the storage instance.
    const applied = spyOn(InMemoryAuthStorage.prototype, "applyDirectoryVerdict")
    try {
      await project.check()
      expect(applied).not.toHaveBeenCalled()
    } finally {
      applied.mockRestore()
    }
    expect(await project.events()).toHaveLength(1)
  })

  test("lifts its own suspensions, never an administrator's", async () => {
    const verdicts: Verdicts = { "sub-ada": { status: "inactive" } }
    const project = await createProject(["ada", "cleo"], verdicts)
    await project.check()
    await project.auth.suspendUserAndRevokeSessions({
      projectId: PROJECT_ID,
      userId: "usr_cleo",
      suspendedAt: new Date(),
    })

    verdicts["sub-ada"] = { status: "active" }
    verdicts["sub-cleo"] = { status: "active" }
    await project.check()

    await expect(project.user("ada")).resolves.toMatchObject({ status: "active" })
    await expect(project.user("ada")).resolves.not.toHaveProperty("suspensionSource")
    await expect(project.user("cleo")).resolves.toMatchObject({
      status: "suspended",
      suspensionSource: "manual",
    })
    expect((await project.events()).map(([type]) => type)).toEqual([
      "user.suspended",
      "user.reactivated",
    ])
  })

  // Removal proof: apply the second read's plan unfiltered; Ben is then suspended on one read.
  test("suspends or reactivates only when a second read agrees", async () => {
    // A replica behind, then the directory catching up: each read's answer for Ada and Ben.
    const reads: [DirectoryVerdict["status"], DirectoryVerdict["status"]][] = [
      ["inactive", "active"],
      ["active", "inactive"],
      ["inactive", "inactive"],
    ]
    let read = 0
    const project = await createProject(["ada", "ben"], () => {
      const [ada, ben] = reads[Math.min(read++, reads.length - 1)] ?? ["active", "active"]
      return { "sub-ada": { status: ada }, "sub-ben": { status: ben } }
    })

    const statuses = async () =>
      [(await project.user("ada"))?.status, (await project.user("ben"))?.status] as const

    // Neither change shows in both reads.
    await project.check()
    expect(read).toBe(2)
    expect(await statuses()).toEqual(["active", "active"])

    await project.check()
    expect(read).toBe(4)
    expect(await statuses()).toEqual(["suspended", "suspended"])

    // A pass that changes no one's status reads once.
    await project.check()
    expect(read).toBe(5)
  })

  // Removal proof: confirm without `delay`; the second read then comes before the minute is up.
  test("waits confirmAfterMs before the confirming read", async () => {
    let reads = 0
    let firstRead!: () => void
    const reachedFirstRead = new Promise<void>((resolve) => (firstRead = resolve))
    const project = await createProject(
      ["ben"],
      () => {
        reads += 1
        firstRead()
        return { "sub-ben": { status: "inactive" } }
      },
      { confirmAfterMs: 60_000 }
    )

    jest.useFakeTimers()
    // Not `project.check()`: its timeout would fire as the fake clock moves.
    const pass = project.host.auth.checkDirectory(new AbortController().signal)
    await reachedFirstRead
    await settle()
    jest.advanceTimersByTime(59_999)
    await settle()
    expect(reads).toBe(1)

    jest.advanceTimersByTime(1)
    await settle()
    expect(reads).toBe(2)
    // What follows the second read, such as delivering the event, runs on real timers.
    jest.useRealTimers()
    await pass
    await expect(project.user("ben")).resolves.toMatchObject({ status: "suspended" })
  })

  test("syncs the groups the directory grants", async () => {
    const project = await createProject(["ada"], {
      "sub-ada": { status: "active", groupIds: [members.id, finance.id] },
    })

    await project.check()

    const groups = await project.auth.groupMemberships.listForUser({
      projectId: PROJECT_ID,
      userId: "usr_ada",
    })
    expect(groups.map(({ groupId, source }) => [groupId, source]).sort()).toEqual([
      [finance.id, "directory"],
      [members.id, "directory"],
    ])
  })

  test("changes nothing for someone it can't answer for, or when the check fails", async () => {
    let failing = false
    const project = await createProject(
      ["ada", "ben"],
      { "sub-ben": { status: "inactive" } },
      {
        fail: () => failing,
      }
    )

    failing = true
    expect(await project.check().catch((error: Error) => error.message)).toBe("Graph answered 403")
    await expect(project.user("ben")).resolves.toMatchObject({ status: "active" })

    failing = false
    await project.check()
    await expect(project.user("ben")).resolves.toMatchObject({ status: "suspended" })
    await expect(project.user("ada")).resolves.toMatchObject({ status: "active" })
  })

  // Removal proof: drop the `suspensions > ...` guard; the pass then suspends all three.
  test("applies nothing when it would suspend more than a quarter of the members at once", async () => {
    const names = ["ada", "ben", "cleo", "dan", "eve", "finn", "gus", "hal"]
    const verdicts: Verdicts = Object.fromEntries(
      names.map((name) => [`sub-${name}`, { status: "active" } as const])
    )
    for (const name of ["ben", "cleo", "dan"]) verdicts[`sub-${name}`] = { status: "inactive" }
    const project = await createProject(names, verdicts)

    // The pass fails, so the project's error reporting hears of it on every run until fixed.
    expect(await project.check().catch((error: Error) => error.message)).toBe(
      "[Sixb] The directory check would suspend 3 members at once, so it suspended no one. " +
        "Check the directory's configuration, or suspend them in Settings › Members."
    )
    await expect(project.user("ben")).resolves.toMatchObject({ status: "active" })

    // Two leaving at once is always allowed, however small the team.
    verdicts["sub-dan"] = { status: "active" }
    await project.check()
    await expect(project.user("ben")).resolves.toMatchObject({ status: "suspended" })
    await expect(project.user("cleo")).resolves.toMatchObject({ status: "suspended" })
  })

  test("runs in the orchestrator's maintenance loop, at its interval", async () => {
    const project = await createProject(["ben"], { "sub-ben": { status: "inactive" } })
    expect(project.host.auth.directoryIntervalMs).toBe(60 * 60_000)

    const maintenance = project.host.startMaintenance([])
    try {
      await waitFor(
        () => project.user("ben"),
        (user) => user?.status === "suspended"
      )
    } finally {
      await maintenance.stop()
    }
  })

  test("refuses an interval under a minute, or a confirmation wait over five", () => {
    expect(
      () =>
        new SixbHost({
          id: PROJECT_ID,
          ontology: [],
          ...createTestRuntimeDeps(),
          auth: strategyWith(() => ({}), { intervalMs: 1_000 }),
        })
    ).toThrow(
      "[Sixb] The auth strategy's directory intervalMs must be at least 60000 (one minute)."
    )
    expect(
      () =>
        new SixbHost({
          id: PROJECT_ID,
          ontology: [],
          ...createTestRuntimeDeps(),
          auth: strategyWith(() => ({}), { confirmAfterMs: 10 * 60_000 }),
        })
    ).toThrow(
      "[Sixb] The auth strategy's directory confirmAfterMs must be from 0 to 300000 (five minutes)."
    )
  })

  // Removal proof: drop the `onUserSuspended` call from `afterStatusChange`; nothing is revoked.
  test("every kind of suspension ends the person's own connections", async () => {
    const project = await createProject(["ada", "ben", "cleo"], {
      "sub-cleo": { status: "inactive" },
    })
    const ended: string[] = []
    const auth = new AuthRuntime({
      projectId: PROJECT_ID,
      storage: project.host.storage,
      security: project.host.definitions.security,
      config: project.strategy,
      events: project.host.events,
      onUserSuspended: async (userId) => {
        ended.push(userId)
        if (userId === "usr_ben") throw new Error("provider unreachable")
      },
    })

    await auth.suspendUser("usr_ada")
    // A revocation that fails is logged; the suspension stands.
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      await auth.suspendUser("usr_ben")
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("Could not revoke the connections of suspended member 'usr_ben'"),
        expect.objectContaining({ message: "provider unreachable" })
      )
    } finally {
      logged.mockRestore()
    }
    await auth.checkDirectory(AbortSignal.timeout(5_000))
    // Reactivating and suspending again ends what they connected in between.
    await auth.reactivateUser("usr_ada")
    await auth.suspendUser("usr_ada")

    expect(ended).toEqual(["usr_ada", "usr_ben", "usr_cleo", "usr_ada"])
    await expect(project.user("ben")).resolves.toMatchObject({ status: "suspended" })
  })
})
