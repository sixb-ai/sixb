import { describe, expect, jest, spyOn, test } from "bun:test"
import { InMemoryLakeStorage, type LanguageModel } from "@sixb/core"
import { BRANCH_KEY_HEADER } from "@sixb/core/internal/branches"
import { flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { registerModelOrigin } from "@sixb/core/internal/model-origins"
import {
  SandboxError,
  type SandboxSourceAuthInput,
  SandboxStateUnavailableError,
  SandboxStillRunningError,
} from "@sixb/core/sandboxes"
import * as copyModule from "../src/copy"
import { BRANCH_IDLE_MS, BRANCH_TICK_MS } from "../src/held-branch"
import { BRANCH_RUNTIME_PORTS } from "../src/ports"
import {
  flush,
  hold,
  NAME,
  onCleanup,
  pass,
  projectId,
  ready,
  row,
  settled,
  setup,
  until,
  useLab,
} from "./helpers/lab"

useLab()

const stillRunning = () =>
  new SandboxStillRunningError("[Sandbox] Vercel sandbox must be stopped before resume.")

describe("a held branch", () => {
  // Guard check: start the runtime without `hostBranchDatabase` or the branch mode's variables
  // in `runtimeEnv` (`held-branch.ts`): the runtime would run on its configuration's storage.
  test("copies production, starts the runtime on its database, and reports what it serves", async () => {
    const { lab, host } = await setup()
    const held = await hold(host)

    const branch = await ready(host)
    await held.stop()

    expect(branch).toMatchObject({ generation: 1, commit: lab.head, notices: [] })
    expect(branch?.url).toContain("127.0.0.1")
    expect(branch?.data).toMatchObject({ objects: 1, skipped: [], lakeSliceId: null })
    expect(lab.imports).toHaveLength(1)
    expect(lab.started[0]).toMatchObject({
      SIXB_BRANCH: NAME,
      SIXB_BRANCH_DATA_FROM: "production",
      // Guard check: drop `BRANCH_RUNTIME_ENV` from `runtimeEnv` (`held-branch.ts`).
      SIXB_BRANCH_RUNTIME: `hosted-${branch?.namespace}`,
      SIXB_BRANCH_PORT: String(branch?.port),
      SIXB_BRANCH_PUBLIC_ORIGIN: branch?.url,
      SIXB_BRANCH_DATABASE_SCHEMA: expect.stringContaining("feature-invoices"),
      SIXB_BRANCH_DATABASE_URL: expect.stringMatching(
        /^postgres:\/\/branch:[0-9a-f]{32}@db\/prod$/
      ),
    })
    expect(lab.started[0]?.SIXB_BRANCH_KEY).toHaveLength(43)
    // What production's copy left in the sandbox once the branch loaded it.
    expect(
      [...lab.files.keys()].filter((path) => path.includes(".parts") || path.endsWith(".copy"))
    ).toEqual([])
  })

  // A branch runs code nobody reviewed: its sandbox reaches what it needs, and nothing else.
  // Guard check: give `create` `{ mode: "all" }` instead of `branchNetwork` in `open`.
  test("reaches only production's instance and API, the package registries and what it is allowed", async () => {
    const { lab, host } = await setup()
    const held = await hold(host, {
      allow: [{ name: "dev redis", origin: "https://redis.dev.shop.test" }],
    })
    await ready(host)
    await held.stop()

    expect(lab.created[0]?.network).toEqual({
      mode: "restricted",
      allow: [
        { name: "npm registry", origin: "https://registry.npmjs.org" },
        { name: "yarn registry", origin: "https://registry.yarnpkg.com" },
        { name: "production API", origin: "https://api.shop.test" },
        { name: "production PostgreSQL", origin: "https://10.0.0.7:5432" },
        { name: "dev redis", origin: "https://redis.dev.shop.test" },
      ],
    })
  })

  // A DuckLake branch installs DuckDB's extensions on first use, which every lake read once
  // failed on: the sandbox could not reach them. Guard check: drop `duckLake` from
  // `branchNetwork` in `open`.
  test("reaches DuckDB's extensions when the project's lake is DuckLake", async () => {
    const lakeStorage = Object.assign(new InMemoryLakeStorage(), {
      standard: { id: "ducklake", version: "1.0" } as const,
    })
    const { lab, host } = await setup({ host: { lakeStorage } })
    const held = await hold(host)
    await ready(host)
    await held.stop()

    expect(lab.created[0]?.network).toMatchObject({
      allow: expect.arrayContaining([
        { name: "DuckDB extensions", origin: "https://extensions.duckdb.org" },
      ]),
    })
  })

  // Agents, workflow steps and embeddings call the project's models from the branch's sandbox.
  // Guard check: drop `models` from `branchNetwork` in `open`.
  test("reaches the providers of the project's models", async () => {
    registerModelOrigin("acme-llm", "https://llm.acme.test/v1")
    const model: LanguageModel = {
      providerId: "acme-llm",
      modelId: "acme-1",
      definition: { kind: "language", providerId: "acme-llm", modelId: "acme-1", capabilities: {} },
      async stream() {
        throw new Error("The branch's network is all this test reads.")
      },
    }
    const { lab, host } = await setup({ host: { models: { language: [model] } } })
    const held = await hold(host)
    await ready(host)
    await held.stop()

    expect(lab.created[0]?.network).toMatchObject({
      mode: "restricted",
      allow: expect.arrayContaining([{ name: "model provider", origin: "https://llm.acme.test" }]),
    })
  })

  // Managed PostgreSQL often keeps temp_file_limit to its superuser: production then cannot cap a
  // branch's temporary files, and says so. Guard check: drop `TEMP_FILES_UNCAPPED` from `copy`.
  test("says when production could not cap its temporary files", async () => {
    const { lab, host } = await setup()
    lab.tempFileLimit = false
    const held = await hold(host)
    const branch = await ready(host)
    await held.stop()

    expect(branch?.notices.map((notice) => notice.code)).toContain("temp-files-uncapped")
  })

  // A failed branch is a failure the project hears of, as any other: through `onError`.
  // Guard check: drop `reportBranchFailure` from `failed` (`held-branch.ts`).
  test("reports its failure to the project's onError", async () => {
    const reported: { type: string; branch?: string; message: string }[] = []
    const { lab, host } = await setup({
      host: {
        onError: (error, context) => {
          reported.push({
            type: context.type,
            ...("branch" in context ? { branch: context.branch } : {}),
            message: error.message,
          })
        },
      },
    })
    lab.answering = false
    const held = await hold(host)
    await until(row(host), (branch) => branch?.state === "failed", { stepMs: 60_000 })
    await settled(held.life)
    await flushSixbErrors(host)

    expect(reported).toEqual([
      { type: "branch.failed", branch: NAME, message: expect.stringContaining("never answered") },
    ])
  })

  // The branch's code answers the worker's status read: a redirect once had production's worker
  // carry the branch's key to any address on its network. Guard check: drop `redirect: "error"`
  // from `report` (`held-branch.ts`).
  test("follows no redirect of its runtime's front", async () => {
    const reached: string[] = []
    const inside = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        reached.push(request.headers.get(BRANCH_KEY_HEADER) ?? "")
        return Response.json({ branch: NAME, generation: 1, state: "ready", requests: 0 })
      },
    })
    onCleanup(() => inside.stop(true))
    const { lab, host } = await setup()
    lab.redirect = `http://127.0.0.1:${inside.port}/admin`

    const held = await hold(host)
    await until(
      async () => lab.started.length,
      (count) => count === 1
    )
    await pass(BRANCH_TICK_MS * 3)
    await held.stop()

    expect(reached).toEqual([])
    expect((await row(host)())?.state).not.toBe("ready")
  })

  // A branch of a private repository clones as its creator: an OAuth source (`githubOAuth`) once
  // got no connection to read with, and every branch failed. Guard check: drop `connectionToken`
  // from `authorizeSourceRead` (`source-auth.ts`).
  test("reads its repository as its creator, through the connections an OAuth source names", async () => {
    const inputs: SandboxSourceAuthInput[] = []
    const { host } = await setup({
      auth: {
        authorize: async (input) => {
          inputs.push(input)
          return {
            requests: [],
            expiresAt: new Date(Date.now() + 60 * 60_000),
            revoke: async () => {},
          }
        },
      },
    })
    const held = await hold(host)
    await ready(host)
    await held.stop()

    expect(inputs[0]?.requestedBy).toEqual({ type: "user", id: "usr_bo" })
    expect(typeof inputs[0]?.connectionToken).toBe("function")
  })

  // Guard check: spread a host value into the runtime's env, or leave `devValues` out of
  // `runtimeEnv`.
  test("runs with the project's dev values and none of production's", async () => {
    const { lab, host } = await setup()
    process.env.SIXB_PRODUCTION_ONLY = "sk_live_prod"
    onCleanup(() => delete process.env.SIXB_PRODUCTION_ONLY)
    const held = await hold(host)
    await ready(host)
    await held.stop()

    expect(lab.started[0]?.STRIPE_KEY).toBe("sk_test_dev")
    expect(Object.values(lab.started[0] ?? {})).not.toContain("sk_live_prod")
  })

  // Guard check: return `[]` for the notices whatever `devEnv` gave in `open`.
  test("says so when it runs without the project's dev values", async () => {
    const { lab, host } = await setup()
    const held = await hold(host, { devEnv: undefined })
    const branch = await ready(host)
    await held.stop()

    expect(branch?.notices.map((notice) => notice.code)).toEqual(["no-dev-env"])
    expect(lab.started[0]).not.toHaveProperty("STRIPE_KEY")
  })

  // Guard check: return false from `needsCopy` when `refreshRequestedAt` is newer than the copy.
  test("takes a new copy on refresh, and restarts the runtime with a new password", async () => {
    const { lab, host, bo } = await setup()
    const held = await hold(host)
    const first = await ready(host)

    jest.advanceTimersByTime(1_000)
    await bo.branches.refresh(NAME)
    await until(
      row(host),
      (branch) => (branch?.data?.takenAt.getTime() ?? 0) > (first?.data?.takenAt.getTime() ?? 0)
    )
    await until(
      async () => lab.started.length,
      (count) => count === 2
    )
    await held.stop()

    expect(lab.imports).toHaveLength(2)
    expect(lab.started[1]?.SIXB_BRANCH_DATABASE_URL).not.toBe(
      lab.started[0]?.SIXB_BRANCH_DATABASE_URL
    )
  })

  // A copy under way once left the old copy's numbers on the row, over a database made anew.
  // Guard check: drop `data: null` from the write that starts `copy`.
  test("has no copy while it takes one, rather than half of one", async () => {
    const { lab, host, bo } = await setup()
    const held = await hold(host)
    await ready(host)

    let release: () => void = () => {}
    lab.copyGate = new Promise<void>((resolve) => {
      release = resolve
    })
    jest.advanceTimersByTime(1_000)
    await bo.branches.refresh(NAME)
    const copying = await until(row(host), (branch) => branch?.state === "copying")
    release()
    await ready(host)
    await held.stop()

    expect(copying?.data).toBeNull()
  })

  // A copy that took 25 minutes once left the branch stopped as idle the moment it was ready.
  // Guard check: drop `lastSeenAt` from the write that ends `copy`.
  test("counts a long copy as use, and stops only once unused after it", async () => {
    const { lab, host } = await setup()
    let release: () => void = () => {}
    lab.copyGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = await hold(host)
    await until(row(host), (branch) => branch?.state === "copying")
    await pass(25 * 60_000, 2_000)
    release()
    await ready(host)

    await pass(5 * 60_000, 2_000)
    expect((await row(host)())?.state).toBe("ready")
    await held.stop()
  })

  // Guard check: drop `dropBranchData` or the row's delete from `teardown` (`held-branch.ts`).
  test("drops its sandbox, its database and its row when deleted", async () => {
    const { lab, host, bo, storage } = await setup()
    const held = await hold(host)
    const branch = await ready(host)

    await bo.branches.delete(NAME)
    await until(row(host), (current) => current === null)
    await settled(held.life)

    expect(lab.destroyed).toEqual(["sandbox-1"])
    expect(await storage.openBranchNamespace(branch!.namespace)).toBeNull()
  })

  // Production keeps a copy's lake slice, and the files it pins, until the branch lets it go.
  // Guard check: read `data` after the write that clears it in `copy`, or drop `releaseSlices`
  // from `teardown` (`held-branch.ts`): the slice stays.
  test("lets production drop its lake slice when it takes a new copy, and when deleted", async () => {
    const { host, bo, storage } = await setup()
    const held = await hold(host)
    const first = await ready(host)
    const slice = async (id: string) => {
      await storage.lakeSlices.create({
        id,
        projectId,
        userId: "usr_bo",
        branch: NAME,
        point: "point",
        versions: [],
        files: [],
        createdAt: new Date(),
        credentialHash: id,
        receivedAt: new Date(),
      })
      await storage.hostedBranches.update(
        { projectId, name: NAME, at: new Date() },
        { data: { ...(await row(host)())!.data!, lakeSliceId: id } }
      )
    }
    const kept = (id: string) => storage.lakeSlices.get({ projectId, id })

    await slice("slice_first")
    jest.advanceTimersByTime(1_000)
    await bo.branches.refresh(NAME)
    await until(
      row(host),
      (branch) => (branch?.data?.takenAt.getTime() ?? 0) > (first?.data?.takenAt.getTime() ?? 0)
    )
    expect(await kept("slice_first")).toBeNull()

    await slice("slice_second")
    await bo.branches.delete(NAME)
    await until(row(host), (current) => current === null)
    await settled(held.life)
    expect(await kept("slice_second")).toBeNull()
  })

  // A copy delivered and never loaded once kept its slice, and production's files, 14 days after
  // its branch stopped. Guard check: drop `releaseUnloaded` from `close` (`held-branch.ts`).
  test("lets production drop the slice of a copy it delivered and never loaded, once it stops", async () => {
    const { lab, host, bo, storage } = await setup()
    await storage.lakeSlices.create({
      id: "slice_delivered",
      projectId,
      userId: "usr_bo",
      branch: NAME,
      point: "point",
      versions: [],
      files: [],
      createdAt: new Date(),
      credentialHash: "slice_delivered",
      receivedAt: new Date(),
    })
    // The copy reads production's lake through that slice, as a copy of a forked lake does. The
    // lab already wraps the copy, and puts it back after the test.
    const copy = spyOn(copyModule, "copyIntoSandbox")
    const deliver = copy.getMockImplementation()!
    copy.mockImplementation(async (...args) => {
      const delivered = await deliver(...args)
      return delivered ? { ...delivered, lakeSliceId: "slice_delivered" } : null
    })
    // The runtime never gets through its load.
    lab.importGate = new Promise<void>(() => {})

    const held = await hold(host)
    await until(
      async () => lab.loading,
      (loading) => loading
    )
    await bo.branches.stop(NAME)
    await settled(held.life)

    expect(await storage.lakeSlices.get({ projectId, id: "slice_delivered" })).toBeNull()
  })

  // Guard check: drop the pull from `tick`.
  test("pulls the commit the remote has", async () => {
    const { lab, host } = await setup()
    const held = await hold(host)
    await ready(host)

    lab.remoteHead = "c".repeat(40)
    await host.storage.hostedBranches!.update(
      { projectId, name: NAME, at: new Date() },
      { remoteCommit: lab.remoteHead }
    )
    await until(
      async () => lab.pulls,
      (pulls) => pulls.length === 1
    )
    await pass(BRANCH_TICK_MS * 5)
    await held.stop()

    expect(lab.pulls).toEqual([lab.remoteHead])
    expect(lab.installs).toEqual([])
  })

  // A push that added a package restarted the runtime on the old dependencies, which failed to
  // import it. Guard check: never reinstall in `pull`.
  test("installs again before it restarts when a push changes the dependencies", async () => {
    const { lab, host } = await setup()
    const held = await hold(host)
    await ready(host)

    lab.remoteHead = "d".repeat(40)
    lab.changedFiles = ["src/invoices.ts", "bun.lock"]
    await host.storage.hostedBranches!.update(
      { projectId, name: NAME, at: new Date() },
      { remoteCommit: lab.remoteHead }
    )
    await until(
      async () => lab.started.length,
      (count) => count === 2
    )
    await held.stop()

    expect(lab.installs).toEqual([lab.remoteHead])
    expect(lab.kills[0]).toBe(1)
  })

  // Guard check: drop the `used` write in `report`: lastSeenAt stays at the open, and the branch
  // stops while someone works on it.
  test("stays up while someone uses it, and stops once nobody has for 20 minutes", async () => {
    const { lab, host } = await setup()
    const held = await hold(host)
    await ready(host)

    for (let minute = 0; minute < 30; minute += 1) {
      lab.requests += 1
      jest.advanceTimersByTime(60_000)
      await flush()
    }
    expect((await row(host)())?.state).toBe("ready")

    jest.advanceTimersByTime(BRANCH_IDLE_MS + 60_000)
    await settled(held.life)
    const stopped = await row(host)()

    expect(stopped).toMatchObject({ wanted: "stopped", state: "stopped", owner: null, url: null })
    expect(stopped?.data?.objects).toBe(1)
  })

  // A delete asked while the worker stopped an idle branch was written over by the worker's
  // retry: the branch came back stopped, its copy kept. Guard check: write `changes` whatever
  // `askedSince` says in `write` (`held-branch.ts`).
  // Guard check for the heartbeat case: let `renewLease` move `decidedOn` too.
  test.each([
    ["delete", "deleted", false],
    ["open", "running", false],
    ["delete", "deleted", true],
    ["open", "running", true],
  ] as const)("keeps the %s asked while it stops the branch, wanted %s, heartbeat between: %p", async (asked, wanted, heartbeat) => {
    const { lab, host, bo } = await setup()
    const held = await hold(host)
    await ready(host)

    let release: () => void = () => {}
    lab.stopGate = new Promise<void>((resolve) => {
      release = resolve
    })
    jest.advanceTimersByTime(BRANCH_IDLE_MS + 60_000)
    await until(
      async () => lab.kills.length,
      (kills) => kills === 1
    )
    await bo.branches[asked](NAME)
    if (heartbeat) {
      // The lease's renewal reads the row the request moved on, before the stop writes.
      jest.advanceTimersByTime(20_000)
      await flush()
    }
    release()
    await settled(held.life)

    expect(await row(host)()).toMatchObject({ wanted, state: "stopped", owner: null })
  })

  // Production closes a branch that takes what its instance cannot spare: its role can log in no
  // more, so a restart would give it a new login. Guard check: ignore `enforced.closed` in
  // `enforceLimits` (`held-branch.ts`).
  test("stops, without starting again, once production closed it, and says why", async () => {
    const { lab, host } = await setup()
    const held = await hold(host)
    const opened = await ready(host)

    lab.closure = { reason: "disk", bytes: 21 * 1024 ** 3, limitBytes: 20 * 1024 ** 3 }
    lab.exits.at(-1)?.(1)
    await settled(held.life)

    expect(await row(host)()).toMatchObject({ wanted: "stopped", state: "stopped", owner: null })
    expect((await row(host)())?.notices).toEqual([
      expect.objectContaining({
        code: "database-limit",
        message: expect.stringContaining("20 GB"),
      }),
    ])
    expect(lab.started).toHaveLength(1)
    expect(lab.closed).toEqual([opened!.namespace])
  })

  // A password the branch's code kept once logged in after its runtime stopped, with nothing
  // holding it to its limits. Guard check: drop `closeBranchData` from `close` or `release`, or
  // call it on a lost hold too (`held-branch.ts`).
  test("takes its login away when it stops or fails, and leaves it to the worker that took it over", async () => {
    const stopped = await setup()
    const first = await hold(stopped.host)
    const opened = await ready(stopped.host)
    await stopped.bo.branches.stop(NAME)
    await settled(first.life)
    expect(stopped.lab.closed).toEqual([opened!.namespace])

    const failing = await setup()
    failing.lab.answering = false
    const second = await hold(failing.host)
    await until(row(failing.host), (branch) => branch?.state === "failed", { stepMs: 60_000 })
    await settled(second.life)
    expect(failing.lab.closed).toHaveLength(1)

    const taken = await setup({ resumable: true })
    const third = await hold(taken.host)
    await ready(taken.host)
    jest.setSystemTime(Date.now() + 2 * 60_000)
    await taken.host.storage.hostedBranches!.update(
      { projectId, name: NAME, at: new Date() },
      { owner: "worker-b", leaseExpiresAt: new Date(Date.now() + 60_000) }
    )
    await pass(BRANCH_TICK_MS * 2)
    await settled(third.life)
    expect(taken.lab.closed).toEqual([])
  })

  // A Vercel session at its plan's maximum once failed the branch, as if its code were broken.
  // Guard check: treat `SandboxNotRunningError` as any other failure in `failed`.
  test("stops, and says so, when its provider ends its machine", async () => {
    const { lab, host } = await setup()
    const held = await hold(host)
    await ready(host)

    lab.sandboxStatus = "stopped"
    await settled(held.life)

    expect(await row(host)()).toMatchObject({ wanted: "stopped", state: "stopped", error: null })
    expect((await row(host)())?.notices.map((notice) => notice.code)).toEqual(["machine-ended"])
  })

  // A sandbox made anew has lost what the branch wrote outside its database: half a copy is worse
  // than a new one. Guard check: open on the old copy when `resumed` is false (`open`).
  test("takes a whole new copy when its machine was lost, and says its data was reset", async () => {
    const { lab, host, bo } = await setup()
    const first = await hold(host)
    await ready(host)
    await bo.branches.stop(NAME)
    await settled(first.life)

    await bo.branches.open(NAME)
    const second = await hold(host)
    const reopened = await ready(host)
    await second.stop()

    expect(lab.created).toHaveLength(2)
    expect(lab.imports).toHaveLength(2)
    expect(reopened?.notices.map((notice) => notice.code)).toEqual(["data-reset"])
  })

  test("keeps its copy when its provider resumes the machine", async () => {
    const { lab, host, bo } = await setup({ resumable: true })
    const first = await hold(host)
    await ready(host)
    await bo.branches.stop(NAME)
    await settled(first.life)

    await bo.branches.open(NAME)
    const second = await hold(host)
    const reopened = await ready(host)
    await second.stop()

    expect(lab.created).toHaveLength(1)
    expect(lab.imports).toHaveLength(1)
    expect(reopened?.notices).toEqual([])
  })

  // A worker killed with its branches up left their Vercel sessions running: the next one made a
  // sandbox under the same name (409), then served on a port Vercel did not route.
  // Guard check: treat `SandboxStillRunningError` as any other failure in `resumeSaved`.
  test("waits for its saved sandbox's last session to stop, then resumes it", async () => {
    const { lab, host, bo } = await setup({ resumable: true })
    const first = await hold(host)
    const opened = await ready(host)
    await bo.branches.stop(NAME)
    await settled(first.life)

    lab.resumeFailures = [stillRunning(), stillRunning()]
    await bo.branches.open(NAME)
    const second = await hold(host)
    const reopened = await ready(host)
    await second.stop()

    expect(lab.created).toHaveLength(1)
    // Guard check: wait without stopping it in `resumeSaved`: Vercel extends a session its
    // keep-alive pushed out, past any wait.
    expect(lab.stoppedByName).toEqual([opened!.sandbox!])
    expect(lab.resumed).toEqual([opened!.sandbox!])
    expect(reopened).toMatchObject({ sandbox: opened!.sandbox, port: opened!.port, notices: [] })
  })

  // Guard check: drop the row's re-read from the wait in `resumeSaved`: the branch waits on.
  test("stops waiting for its saved sandbox once it is deleted", async () => {
    const { lab, host, bo } = await setup({ resumable: true })
    const first = await hold(host)
    await ready(host)
    await bo.branches.stop(NAME)
    await settled(first.life)

    lab.resumeFailures = Array.from({ length: 100 }, stillRunning)
    await bo.branches.open(NAME)
    const second = await hold(host)
    await until(
      async () => lab.stoppedByName.length,
      (stops) => stops === 1
    )
    await bo.branches.delete(NAME)
    await until(row(host), (branch) => branch === null, { stepMs: 15_000, steps: 10 })
    await settled(second.life)

    expect(lab.created).toHaveLength(1)
  })

  test("fails in its own words when its saved sandbox's session never stops", async () => {
    const { lab, host, bo } = await setup({ resumable: true })
    const first = await hold(host)
    await ready(host)
    await bo.branches.stop(NAME)
    await settled(first.life)

    lab.resumeFailures = Array.from({ length: 100 }, stillRunning)
    await bo.branches.open(NAME)
    const second = await hold(host)
    await until(row(host), (branch) => branch?.state === "failed", { stepMs: 60_000, steps: 20 })
    await settled(second.life)

    expect((await row(host)())?.error?.message).toStartWith(
      "[SixbBranchWorker] The last session of branch 'feature/invoices''s sandbox still runs after 12 minutes."
    )
  })

  // Guard check: drop the `destroySaved` before `create` in `createSandbox`, or draw a new port.
  test("makes its sandbox anew under its name and port once its saved state is gone", async () => {
    const { lab, host, bo } = await setup({ resumable: true })
    const first = await hold(host)
    const opened = await ready(host)
    await bo.branches.stop(NAME)
    await settled(first.life)

    lab.resumeFailures = [new SandboxStateUnavailableError("[Sandbox] Its snapshot expired.")]
    await bo.branches.open(NAME)
    const second = await hold(host)
    const reopened = await ready(host)
    await second.stop()

    expect(lab.destroyed).toEqual([opened!.sandbox!])
    expect(lab.created.map((options) => options.ports)).toEqual([[opened!.port!], [opened!.port!]])
    expect(reopened?.notices.map((notice) => notice.code)).toEqual(["data-reset"])
  })

  // Only a provider that says the state is gone lets the name go. Guard check: catch every
  // failure of `resume` in `resumeSaved` and make the sandbox anew.
  test("fails and keeps its sandbox's name when it cannot resume it for another reason", async () => {
    const { lab, host, bo } = await setup({ resumable: true })
    const first = await hold(host)
    const opened = await ready(host)
    await bo.branches.stop(NAME)
    await settled(first.life)

    lab.resumeFailures = [new SandboxError("[Sandbox] Vercel persistent sandbox resume failed.")]
    await bo.branches.open(NAME)
    const second = await hold(host)
    await settled(second.life)

    expect(await row(host)()).toMatchObject({
      state: "failed",
      error: { message: expect.stringContaining("resume failed") },
      sandbox: opened!.sandbox,
      port: opened!.port,
    })
    expect(lab.created).toHaveLength(1)
    expect([...lab.saved]).toEqual([opened!.sandbox!])
  })

  // The provider ran the checkout as its setup, bound to 2 minutes, failing with "Sandbox
  // environment initialization failed" alone. Guard check: pass `branchCheckout` to `create` as
  // its `environment`, or drop the stderr from the error in `checkOut`.
  test("checks out with its own commands, and fails in the words of the step that failed", async () => {
    const { lab, host } = await setup()
    lab.checkoutFailure = {
      step: "--frozen-lockfile",
      stderr: "error: lockfile had changes, but lockfile is frozen",
    }
    const held = await hold(host)
    await settled(held.life)

    expect(lab.created[0]?.environment).toEqual({})
    expect(lab.checkout).toHaveLength(3)
    expect((await row(host)())?.error?.message).toBe(
      "[SixbBranchWorker] Could not install the branch's dependencies: error: lockfile had changes, but lockfile is frozen"
    )
    expect(lab.destroyed).toEqual(["sandbox-1"])
  })

  test("says which step ran out of time", async () => {
    const { lab, host } = await setup()
    lab.checkoutFailure = { step: "git clone", stderr: "", timedOut: true }
    const held = await hold(host)
    await settled(held.life)

    expect((await row(host)())?.error?.message).toBe(
      "[SixbBranchWorker] Could not clone the branch: it took longer than 10 minutes."
    )
  })

  // A first checkout that failed left a saved sandbox with no checkout, which every open then
  // resumed. Guard check: return the resumed sandbox whatever `finishedCheckout` says.
  test("makes its saved sandbox anew when its first checkout never finished", async () => {
    const { lab, host, bo } = await setup({ resumable: true })
    lab.checkoutFailure = { step: "git clone", stderr: "fatal: unable to access the repository" }
    const first = await hold(host)
    await settled(first.life)
    const failed = await row(host)()
    expect(failed).toMatchObject({ state: "failed", sandbox: expect.any(String) })

    await bo.branches.open(NAME)
    const second = await hold(host)
    await ready(host)
    await second.stop()

    expect(lab.destroyed).toEqual([failed!.sandbox!])
    expect(lab.created).toHaveLength(2)
    expect(lab.created[1]?.ports).toEqual([failed!.port!])
  })

  // A port drawn from the kernel's ephemeral range collided with an outgoing connection's.
  // Guard check: draw from 41000 as before, or check only `port` in `freeRuntimePort`.
  test("serves on free ports below the ephemeral range: its front, its API and its app", async () => {
    const { lab, host } = await setup()
    const held = await hold(host)
    const branch = await ready(host)
    await held.stop()

    const port = branch!.port!
    expect(lab.created[0]?.ports).toEqual([port])
    expect(port % 4).toBe(0)
    expect(port).toBeGreaterThanOrEqual(BRANCH_RUNTIME_PORTS.from)
    expect(port + 2).toBeLessThan(32_768)
  })

  // Guard check: start the runtime again at once in `restartExited`.
  test("starts a runtime that keeps exiting again, later each time", async () => {
    const { lab, host } = await setup()
    lab.state = "starting"
    const held = await hold(host)
    await until(
      async () => lab.started.length,
      (count) => count === 1
    )

    // How long the worker waits after the runtime exits before it starts it again.
    const restartDelay = async () => {
      const count = lab.started.length
      const exitedAt = Date.now()
      lab.exits.at(-1)?.(1)
      await until(
        async () => lab.started.length,
        (started) => started > count,
        { stepMs: 1_000, steps: 200 }
      )
      return Date.now() - exitedAt
    }

    expect(await restartDelay()).toBeGreaterThanOrEqual(5_000)
    expect(await restartDelay()).toBeGreaterThanOrEqual(10_000)
    await held.stop()
  })
})
