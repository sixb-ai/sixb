import { describe, expect, spyOn, test } from "bun:test"
import {
  col,
  defineAction,
  defineConnector,
  defineDataset,
  defineObjectType,
  defineSchedule,
  defineSync,
  events,
  prop,
  type SixbErrorContext,
  SixbHost,
  type SixbHostOptions,
} from "../src"
import { drainActionRuns } from "../src/actions"
import type { MagicLinkAuthStrategy, OidcAuthStrategy } from "../src/auth"
import type { AuthStrategyDirectory } from "../src/auth/strategy"
import { emptyGrantIndex } from "../src/authorization"
import { putOnBranch, resolveBranchMode, type SixbBranch } from "../src/branch-mode"
import { reportMaintenancePassFailure } from "../src/error-reporting/capability"
import { isSixbError } from "../src/errors/internal"
import { InMemoryLakeStorage, type LakeMaintenance } from "../src/lake-storage"
import { createProjectionRunId } from "../src/projections/internal"
import { InMemoryQueues } from "../src/queues"
import { SyncRunDispatcher } from "../src/syncs/run-dispatch"
import { createTestSixb } from "../src/testing"
import {
  connectAccount,
  createHarness,
  managementCommand,
  projectOwner,
  rejectionOf,
} from "./connector-connections.fixture"
import { createTestRuntimeDeps, waitFor } from "./test-runtime-deps"

// Each gate below says how to prove it: remove the gate, and its test fails.

const PROJECT_ID = "branch-mode"
const BRANCH: SixbBranch = { name: "feature/invoices", dataFrom: "production" }

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { primary: true, required: true }), prop("status", "string")],
})

/**
 * A host on `branch`, as `sixb dev --from production` starts one. The variables are read when core
 * loads, so a test process puts its host on a branch through its options instead; the test that
 * spawns a process below proves the variables.
 */
function buildHost(options: SixbHostOptions, branch?: SixbBranch): SixbHost {
  return new SixbHost(branch ? putOnBranch(options, branch) : options)
}

/** The same project twice: as production runs it, and on a branch. */
function hosts(options: Omit<SixbHostOptions, keyof ReturnType<typeof createTestRuntimeDeps>>) {
  const create = (branch?: SixbBranch) =>
    buildHost({ id: PROJECT_ID, ...createTestRuntimeDeps(), onError: () => {}, ...options }, branch)

  return { production: create(), branch: create(BRANCH) }
}

function expectRefusal(error: unknown, ...mentions: string[]): void {
  expect(isSixbError(error) && error.code).toBe("branch.refused")
  const message = (error as Error).message
  expect(message).toStartWith(`[Sixb] Branch "${BRANCH.name}": `)
  for (const mention of mentions) expect(message).toContain(mention)
}

describe("branch mode", () => {
  test("is off unless the host sets both variables", () => {
    expect(resolveBranchMode({})).toBeNull()
    expect(
      resolveBranchMode({ SIXB_BRANCH: "feature/invoices", SIXB_BRANCH_DATA_FROM: "production" })
    ).toEqual(BRANCH)

    expect(() => resolveBranchMode({ SIXB_BRANCH: "feature/invoices" })).toThrow(
      "only SIXB_BRANCH is set"
    )
    expect(() => resolveBranchMode({ SIXB_BRANCH_DATA_FROM: "production" })).toThrow(
      "only SIXB_BRANCH_DATA_FROM is set"
    )
    expect(() =>
      resolveBranchMode({ SIXB_BRANCH: "feature/invoices", SIXB_BRANCH_DATA_FROM: "staging" })
    ).toThrow('SIXB_BRANCH_DATA_FROM must be "production"')
    expect(() =>
      resolveBranchMode({ SIXB_BRANCH: "my branch", SIXB_BRANCH_DATA_FROM: "production" })
    ).toThrow("must be a git branch name")
  })

  // Guard check: remove the NODE_ENV check in `resolveBranchMode` (`branch-mode/mode.ts`).
  test("never runs with NODE_ENV=production", () => {
    expect(() =>
      resolveBranchMode({
        SIXB_BRANCH: "feature/invoices",
        SIXB_BRANCH_DATA_FROM: "production",
        NODE_ENV: "production",
      })
    ).toThrow('Branch "feature/invoices" cannot run with NODE_ENV=production')
  })

  // Guard check: read `process.env` in `resolveHostBranch` instead of the values `mode.ts` captured
  // when it loaded (`branch-mode/mode.ts`): the tampered config runs off the branch.
  test.each([
    "delete",
    "rename",
  ])("holds when the project's code tampers with the variables (%s)", async (tamper) => {
    const child = Bun.spawn(
      [process.execPath, `${import.meta.dir}/fixtures/branch-config.ts`, tamper],
      {
        env: { ...process.env, SIXB_BRANCH: BRANCH.name, SIXB_BRANCH_DATA_FROM: "production" },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const kill = setTimeout(() => child.kill("SIGKILL"), 10_000)
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(kill))

    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual(BRANCH)
  })

  test("is what the host and every execution read as `branch`", () => {
    const { production, branch } = hosts({ ontology: [Invoice] })

    expect(production.branch).toBeNull()
    expect(createTestSixb(production).branch).toBeNull()
    expect(branch.branch).toEqual(BRANCH)
    expect(createTestSixb(branch).branch).toEqual(BRANCH)
  })
})

describe("connectors on a branch", () => {
  // Guard check: remove `refuseOnBranch` from `ConnectorService.connect` (`connectors/service.ts`).
  test("refuse a static connector's client before the adapter connects", async () => {
    let connects = 0
    const erp = defineConnector("erp", {
      type: "sql",
      connect: () => {
        connects += 1
        return { query: () => [] }
      },
    })
    const { production, branch } = hosts({ ontology: [Invoice], connectors: [erp] })

    await createTestSixb(production).connector(erp)
    expect(connects).toBe(1)

    const error = await rejectionOf(createTestSixb(branch).connector(erp))
    expectRefusal(error, "connector 'erp'")
    expect(connects).toBe(1)
  })

  // Guard check: remove `refuseOnBranch` from any of `connectExecutionConnection`,
  // `assertExecutionConnectionUsable` or `createConnectionTokenSource` in `connectors/service.ts`,
  // or return the unwrapped process from `connectionProcess`.
  test("refuse an OAuth connection's client, its token and every connection change", async () => {
    const harness = createHarness()
    await harness.ready
    const { authorizationId } = await connectAccount(harness)
    const [connection] = await harness.service.listAllConnections(harness.connector)
    const before = { ...harness.counts(), connects: harness.connectionSignals.length }

    // The same connection, as a branch would find it if one ever reached its storage.
    const branch = harness.peer({ branch: BRANCH })
    const process = branch.connectionProcess!

    expectRefusal(
      await rejectionOf(branch.connectExecutionConnection(harness.connector, connection!)),
      "connector 'social'"
    )
    expectRefusal(
      await rejectionOf(branch.assertExecutionConnectionUsable(harness.connector, connection!)),
      "connector 'social'"
    )
    expectRefusal(
      await rejectionOf(
        branch.connectConnection(harness.connector, { owner: projectOwner, slot: "social" })
      ),
      "connector 'social'"
    )
    expect(() =>
      branch.createConnectionTokenSource(harness.connector, { owner: projectOwner, slot: "social" })
    ).toThrow("connector 'social' is not called on a branch")

    const command = managementCommand()
    const refusedChanges = [
      process.startAuthorization(command, "social", {
        owner: projectOwner,
        slot: "other",
        redirectUri: "https://app.test/callback",
      }),
      process.startReauthorization(command, "social", connection!.id, {
        redirectUri: "https://app.test/callback",
        returnTo: "/",
      }),
      process.revokeConnection(command, "social", connection!.id),
      process.revokeAuthorization(command, "social", authorizationId),
      process.disconnect(command, "social", connection!.id),
      process.callbackProcess.completeConnectionRun({
        state: "state",
        code: "code",
        redirectUri: "https://app.test/callback",
        callbackBinding: "binding",
        callbackParameters: {},
      }),
    ]
    for (const change of refusedChanges) {
      expectRefusal(await rejectionOf(change), "connections")
    }

    // Reads stay, so the console still shows what there is.
    expect(await process.listConnections(command, "social")).toHaveLength(1)
    expect({ ...harness.counts(), connects: harness.connectionSignals.length }).toEqual(before)
  })
})

describe("actions on a branch", () => {
  // Guard check: remove the branch check at the top of `runWritebackPhase`
  // (`actions/run/writeback.ts`): the writeback runs and the edits apply.
  test("fail at their writeback, before it runs, and apply no edits", async () => {
    const written: string[] = []
    const sendInvoice = defineAction("sendInvoice")
      .on(Invoice)
      .params({})
      .writeback(({ run }) => {
        written.push(run.id)
        return { sentAt: "2026-11-24T10:00:00.000Z" }
      })
      .edits(({ objects, subject }) => {
        objects(Invoice).byId(subject.primaryId).update({ status: "sent" })
      })
    const { production, branch } = hosts({ ontology: [Invoice], actions: [sendInvoice] })

    for (const host of [production, branch]) {
      await createTestSixb(host)
        .objects(Invoice)
        .upsert({ properties: { id: "inv-1", status: "draft" } })
    }

    const sent = await createTestSixb(production)
      .objects(Invoice)
      .requestAction({ id: "inv-1", actionId: "sendInvoice", params: {} })
    expect(sent.status).toBe("succeeded")

    const refused = await createTestSixb(branch)
      .objects(Invoice)
      .requestAction({ id: "inv-1", actionId: "sendInvoice", params: {} })

    expect(refused).toMatchObject({
      status: "failed",
      phase: "writeback",
      error: { code: "branch.refused" },
      writeback: { status: "failed", error: { code: "branch.refused" } },
    })
    expect(refused.error?.message).toContain("action 'sendInvoice' has a writeback")
    expect(written).toEqual([sent.id])

    const invoice = await createTestSixb(branch).objects(Invoice).get("inv-1")
    expect(invoice?.properties.status).toBe("draft")
  })

  // Guard check: call `callEffects` whatever the branch in `runActionEffects`
  // (`actions/run/effects.ts`): the effects run and record as succeeded.
  test("skip their effects, and record them as skipped on the run", async () => {
    const notified: string[] = []
    const approve = defineAction("approveInvoice")
      .on(Invoice)
      .params({})
      .edits(({ objects, subject }) => {
        objects(Invoice).byId(subject.primaryId).update({ status: "approved" })
      })
      .effects(({ subject }) => {
        notified.push(subject.primaryId)
      })
    const { production, branch } = hosts({ ontology: [Invoice], actions: [approve] })

    const effectsOf = async (host: SixbHost) => {
      const sixb = createTestSixb(host)
      await sixb.objects(Invoice).upsert({ properties: { id: "inv-1", status: "draft" } })
      const run = await sixb
        .objects(Invoice)
        .requestAction({ id: "inv-1", actionId: "approveInvoice", params: {} })
      await drainActionRuns(host, 5_000)

      const recorded = await host.storage.actionRuns?.getById({ projectId: PROJECT_ID, id: run.id })
      return { run, effects: recorded?.effects }
    }

    expect((await effectsOf(production)).effects?.status).toBe("succeeded")
    expect(notified).toEqual(["inv-1"])

    const onBranchRun = await effectsOf(branch)
    expect(onBranchRun.run.status).toBe("succeeded")
    expect(onBranchRun.effects?.status).toBe("skipped")
    expect(notified).toEqual(["inv-1"])

    const invoice = await createTestSixb(branch).objects(Invoice).get("inv-1")
    expect(invoice?.properties.status).toBe("approved")
  })
})

describe("syncs on a branch", () => {
  const erp = defineConnector("erp", { type: "sql", connect: () => ({}) })
  const rawInvoices = defineDataset("raw.invoices", { schema: [col("id", "string")] })
  const syncInvoices = defineSync("sync-invoices")
    .from(erp)
    .read(() => [])
    .intoDataset(rawInvoices)

  // The error is coded and not retryable, which the orchestrator's dispatch reports once and drops
  // (`isPermanentDispatchFailure`, `packages/orchestrator/src/job-dispatch.ts`). Guard check:
  // remove the branch check from `SyncRunDispatcher.dispatch` (`syncs/run-dispatch.ts`).
  test("refuse a trigger's run with a permanent error, and queue nothing", async () => {
    const { production, branch } = hosts({
      ontology: [Invoice],
      connectors: [erp],
      datasets: [rawInvoices],
      syncs: [syncInvoices],
    })
    const trigger = {
      syncId: syncInvoices.id,
      runId: "sync-run-1",
      source: { type: "event" as const, eventId: "evt-1" },
      correlationId: "correlation-1",
    }

    expect(await new SyncRunDispatcher(production).dispatch(trigger)).toHaveLength(1)

    const error = await rejectionOf(new SyncRunDispatcher(branch).dispatch(trigger))
    expectRefusal(error, "sync 'sync-invoices'")
    expect(isSixbError(error) && error.retryable).toBe(false)
    expect(
      await branch.storage.syncRuns?.getById({ projectId: PROJECT_ID, id: "sync-run-1" })
    ).toBeNull()
  })

  // Guard check: remove the branch check from `requestSyncRun` (`syncs/request.ts`).
  test("refuse a run someone requests", async () => {
    const { production, branch } = hosts({
      ontology: [Invoice],
      connectors: [erp],
      datasets: [rawInvoices],
      syncs: [syncInvoices],
    })

    await createTestSixb(production).syncs.request({ syncId: syncInvoices.id })

    const error = await rejectionOf(
      createTestSixb(branch).syncs.request({ syncId: syncInvoices.id })
    )
    expectRefusal(error, "sync 'sync-invoices'")
  })
})

describe("upkeep on a branch", () => {
  const daily = defineSchedule("daily-reminders").cron("0 8 * * *")
  const onInvoice = defineSchedule("invoice-created").on(events.object(Invoice).created())
  const rawInvoices = defineDataset("raw.invoices", { schema: [col("id", "string")] })

  function retentionLake(): { lake: InMemoryLakeStorage; applied: boolean[] } {
    const applied: boolean[] = []
    const maintenance: LakeMaintenance = {
      async applyRetention(options = {}) {
        applied.push(options.dryRun ?? false)
        return {
          dryRun: options.dryRun ?? false,
          keepVersionsForMs: 0,
          deleteFilesAfterMs: 0,
          expiredVersions: 0,
          keptVersions: 0,
          deletedFiles: 0,
          orphanedFiles: 0,
          hasMore: false,
        }
      },
      async describeStorage() {
        return []
      },
    }
    const lake = new InMemoryLakeStorage()
    Object.defineProperty(lake, "maintenance", { value: maintenance })
    return { lake, applied }
  }

  const directory: OidcAuthStrategy & { readonly directory: AuthStrategyDirectory } = {
    id: "entra",
    kind: "oidc",
    async startOidcSignIn(): Promise<never> {
      throw new Error("unused")
    },
    async completeOidcSignIn(): Promise<never> {
      throw new Error("unused")
    },
    async deliverInvitation() {
      return { status: "sent" }
    },
    providerProfileFields: () => [],
    directory: { confirmAfterMs: 0, check: async () => new Map() },
  }

  function upkeepHost(onBranch: boolean) {
    return buildHost(
      {
        id: PROJECT_ID,
        ...createTestRuntimeDeps(),
        lakeStorage: retentionLake().lake,
        ontology: [Invoice],
        datasets: [rawInvoices],
        schedules: [daily, onInvoice],
        auth: directory,
      },
      onBranch ? BRANCH : undefined
    )
  }

  /** The passes a started loop runs, read from the heartbeat it writes to storage. */
  async function passesOf(host: SixbHost): Promise<readonly string[]> {
    const maintenance = host.startMaintenance([])
    try {
      const [beat] = await waitFor(
        () => host.storage.maintenanceHeartbeats!.list({ projectId: PROJECT_ID }),
        (beats) => beats.length > 0
      )
      return beat!.passes.map((pass) => pass.id).sort()
    } finally {
      await maintenance.stop()
    }
  }

  // Guard check: put `this.cron` back unconditionally in `startMaintenance`, return the directory
  // pass whatever the branch in `directoryPasses` (`runtime/host.ts`). Lake retention runs: on a
  // branch's lake it never deletes production's files (`storage/ducklake` README, Branches).
  test("runs no cron schedule and no directory check", async () => {
    const notice = spyOn(console, "info").mockImplementation(() => {})

    try {
      expect(await passesOf(upkeepHost(false))).toEqual([
        "cron",
        "directory",
        "lake-retention",
        "ontology",
      ])
      expect(notice).not.toHaveBeenCalled()

      expect(await passesOf(upkeepHost(true))).toEqual(["lake-retention", "ontology"])
      expect(notice).toHaveBeenCalledTimes(1)
      expect(String(notice.mock.calls[0]?.[0])).toContain(
        "cron schedules do not run on their own clock on a branch ('daily-reminders')"
      )
    } finally {
      notice.mockRestore()
    }
  })

  // Guard check: drop the `assertAuthorized` loop from `SchedulesRuntime.run`
  // (`schedules/execution.ts`): a caller without the sync's run grant starts it.
  test("still runs a cron schedule now, for someone who may run what it starts", async () => {
    const erp = defineConnector("erp", { type: "sql", connect: () => ({}) })
    const idle = defineSchedule("idle").cron("0 9 * * *")
    const importInvoices = defineSync("import-invoices")
      .when(daily)
      .from(erp)
      .read(() => [])
      .intoDataset(rawInvoices)
    const host = buildHost(
      {
        id: PROJECT_ID,
        ...createTestRuntimeDeps(),
        ontology: [Invoice],
        connectors: [erp],
        datasets: [rawInvoices],
        syncs: [importInvoices],
        schedules: [daily, onInvoice, idle],
      },
      BRANCH
    )
    const sixb = createTestSixb(host)

    const run = await sixb.schedules.run(daily.id)

    const triggered = (await host.events.read({ limit: 10 })).filter(
      (event) => event.type === "schedule.triggered"
    )
    expect(triggered.map((event) => event.payload)).toEqual([
      {
        scheduleId: daily.id,
        occurrenceAt: run.triggeredAt,
        triggeredAt: run.triggeredAt,
        occurrenceKey: run.occurrenceKey,
      },
    ])

    const stranger = createTestSixb(host, {
      authorization: {
        principal: { type: "user", id: "usr_stranger" },
        groupIds: [],
        roleIds: [],
        grants: emptyGrantIndex(),
      },
    })
    expect(String(await rejectionOf(stranger.schedules.run(daily.id)))).toContain(
      "not allowed to run sync 'import-invoices'"
    )

    await expect(sixb.schedules.run(onInvoice.id)).rejects.toThrow("runs when its event happens")
    await expect(sixb.schedules.run(idle.id)).rejects.toThrow("starts nothing")
    await expect(sixb.schedules.run("missing")).rejects.toThrow("Unknown schedule 'missing'")
  })

  // Guard check: remove the branch check at the top of `AuthRuntime.checkDirectory`.
  test("refuses a directory check someone runs", async () => {
    const error = await rejectionOf(
      upkeepHost(true).auth.checkDirectory(new AbortController().signal)
    )
    expectRefusal(error, "directory is not checked")
  })

  // Guard check: return the configured strategy from `AuthRuntime.getStrategy` whatever the
  // branch, or drop either entry from `refused` in `withoutEmails` (`auth/runtime.ts`).
  test("emails no invitation and no sign-in link", async () => {
    const sent: string[] = []
    const magicLink: MagicLinkAuthStrategy = {
      id: "email",
      kind: "magicLink",
      async requestMagicLink() {
        sent.push("sign-in link")
        return { status: "sent" }
      },
      async completeMagicLinkSignIn(): Promise<never> {
        throw new Error("unused")
      },
      async deliverInvitation() {
        sent.push("invitation")
        return { status: "sent" }
      },
    }
    const create = (branch?: SixbBranch) =>
      buildHost(
        { id: PROJECT_ID, ...createTestRuntimeDeps(), ontology: [Invoice], auth: magicLink },
        branch
      ).auth.getStrategy() as MagicLinkAuthStrategy

    const production = create()
    await production.requestMagicLink({} as never)
    await production.deliverInvitation({} as never)
    expect(sent).toEqual(["sign-in link", "invitation"])

    const branch = create(BRANCH)
    expectRefusal(await rejectionOf(branch.requestMagicLink({} as never)), "no sign-in link")
    expectRefusal(await rejectionOf(branch.deliverInvitation({} as never)), "no invitation")
    expect(branch.id).toBe("email")
    expect(sent).toEqual(["sign-in link", "invitation"])
  })
})

describe("what a branch tells and shares", () => {
  // Guard check: report `reported` as is in `SixbErrorReporter.report` (`error-reporting/reporter.ts`).
  test("hands `onError` the branch's name", async () => {
    const contexts: SixbErrorContext[] = []
    const create = (branch?: SixbBranch) =>
      buildHost(
        {
          id: PROJECT_ID,
          ...createTestRuntimeDeps(),
          ontology: [Invoice],
          onError: (_error, context) => {
            contexts.push(context)
          },
        },
        branch
      )

    for (const host of [create(), create(BRANCH)]) {
      reportMaintenancePassFailure(host, new Error("pass failed"), {
        projectId: PROJECT_ID,
        passId: "ontology",
        consecutiveFailures: 1,
      })
    }

    await waitFor(
      () => contexts,
      (reported) => reported.length === 2
    )
    expect(contexts[0]?.branch).toBeUndefined()
    expect(contexts[1]?.branch).toBe(BRANCH.name)
  })

  // Guard check: hand `options.queues` to the branch host unwrapped (`runtime/host.ts`).
  test("keeps its jobs from production's workers on shared queues", async () => {
    const queues = new InMemoryQueues()
    const create = (branch?: SixbBranch) =>
      buildHost({ id: PROJECT_ID, ...createTestRuntimeDeps(), queues, ontology: [Invoice] }, branch)
    const production = create()
    const branch = create(BRANCH)
    const job = (id: string) => ({
      id,
      type: "pipeline.run.requested" as const,
      payload: { runId: id },
    })

    await branch.queues.pipelines.enqueue({ projectId: PROJECT_ID, jobs: [job("branch-run")] })
    await production.queues.pipelines.enqueue({ projectId: PROJECT_ID, jobs: [job("prod-run")] })

    const claim = (host: SixbHost) =>
      host.queues.pipelines.claim({ projectId: PROJECT_ID, workerId: "worker", limit: 10 })

    const claimedByProduction = await claim(production)
    expect(claimedByProduction.map(({ job }) => job.id)).toEqual(["prod-run"])

    const claimedByBranch = await claim(branch)
    expect(claimedByBranch.map(({ job }) => [job.id, job.projectId])).toEqual([
      ["branch-run", PROJECT_ID],
    ])
  })

  // Guard check: hand `options.broker` to the branch host unwrapped (`runtime/host.ts`).
  test("keeps its events from production's subscribers on a shared broker", async () => {
    const deps = createTestRuntimeDeps()
    const create = (branch?: SixbBranch) =>
      buildHost(
        {
          id: PROJECT_ID,
          ...createTestRuntimeDeps(),
          broker: deps.broker,
          ontology: [Invoice],
        },
        branch
      )
    const production = create()
    const branch = create(BRANCH)

    await createTestSixb(branch)
      .objects(Invoice)
      .upsert({ properties: { id: "inv-branch" } })
    await createTestSixb(production)
      .objects(Invoice)
      .upsert({ properties: { id: "inv-prod" } })

    const created = async (host: SixbHost) =>
      (
        await waitFor(
          () => host.events.read({ limit: 10 }),
          (read) => read.some((event) => event.type === "object.created")
        )
      )
        .filter((event) => event.type === "object.created")
        .map((event) => (event.payload as { primaryId: string }).primaryId)

    expect(await created(production)).toEqual(["inv-prod"])
    expect(await created(branch)).toEqual(["inv-branch"])
  })

  // Guard check: drop `branch` from the hash in `createProjectionRunId` (`projections/run-id.ts`).
  test("names its projection runs apart from production's, which keep their ids", () => {
    const identity = {
      projectionId: "invoices",
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion: {
        datasetId: "raw.invoices",
        versionId: "ducklake:42",
        createdAt: "2026-11-24T10:00:00.000Z",
      },
      ontologyRevision: "ontology-1",
      projectionRevision: "projection-1",
      ownershipHash: "ownership-1",
    } as Parameters<typeof createProjectionRunId>[1]

    const productionId = createProjectionRunId(PROJECT_ID, identity, null)
    expect(createProjectionRunId(PROJECT_ID, identity, null)).toBe(productionId)
    expect(createProjectionRunId(PROJECT_ID, identity, BRANCH)).not.toBe(productionId)
  })
})
