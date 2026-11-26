import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  can,
  change,
  col,
  defineDataset,
  defineGroup,
  defineMarking,
  defineRole,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import {
  issueLakeSliceToken,
  LAKE_SLICE_KEEP_MS,
  type LakeSliceHost,
  openLakeSliceFile,
  releaseLakeSliceFiles,
  renewLakeSliceToken,
  writeLakeSlice,
} from "../src/datasets/lake-slices"
import {
  type DatasetVersionRef,
  InMemoryLakeStorage,
  type LakeFile,
  type LakeForks,
  type ReleaseLakeSliceFilesInput,
  type WriteLakeSliceInput,
} from "../src/lake-storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const financial = defineMarking("financial")
const invoices = defineDataset("erp.invoices", {
  schema: [col("id", "string"), col("amount", "decimal", { markings: [financial] })],
  primaryKey: "id",
})
const orders = defineDataset("erp.orders", {
  schema: [col("id", "string"), col("total", "float64")],
  primaryKey: "id",
})
const payroll = defineDataset("hr.payroll", {
  schema: [col("id", "string"), col("salary", "float64")],
  primaryKey: "id",
})

const analysts = defineGroup("analysts")
const finance = defineGroup("finance")
const hr = defineGroup("hr")
const readers = defineRole("readers", {
  grantedTo: [analysts, finance],
  grants: [can.view(invoices), can.view(orders)],
})
const financeClearance = defineRole("finance-clearance", {
  grantedTo: [finance],
  clearances: [financial],
})
const hrReaders = defineRole("hr-readers", { grantedTo: [hr], grants: [can.view(payroll)] })

/** A lake whose slices and files the tests record and serve from memory. */
class ForkableLake extends InMemoryLakeStorage {
  readonly askedAbout: string[] = []
  readonly slices: WriteLakeSliceInput[] = []
  readonly releases: ReleaseLakeSliceFilesInput[] = []
  readonly forks: LakeForks = {
    currentPoint: async () => "point-1",
    versionsAt: async ({ datasetIds }) => {
      this.askedAbout.push(...datasetIds)
      return new Map(
        await Promise.all(
          datasetIds.map(async (id) => [id, await this.getLatestVersion(id)] as const)
        )
      )
    },
    writeSlice: async (input) => {
      this.slices.push(input)
      const files = new Set(input.versions.map(filePath))
      await input.record(files)
      return files
    },
    openFile: async (path) => fileOf(path),
    releaseFiles: async (input) => {
      this.releases.push(input)
      return 0
    },
  }
}

const filePath = ({ datasetId, versionId }: DatasetVersionRef) =>
  `${datasetId}/${versionId}.parquet`
const fileOf = (path: string): LakeFile => ({
  sizeBytes: path.length,
  read: () => new Response(path).body as ReadableStream<Uint8Array>,
})

async function seed() {
  const lakeStorage = new ForkableLake()
  const host = new SixbHost({
    id: "lake-slices",
    ontology: [],
    datasets: [invoices, orders, payroll],
    markings: [financial],
    groups: [analysts, finance, hr],
    roles: [readers, financeClearance, hrReaders],
    ...createTestRuntimeDeps(),
    lakeStorage,
  })
  const trusted = createTestSixb(host)
  await trusted.datasets.ingest(invoices, {
    changes: [change.upsert({ id: "inv-1", amount: "12.00" })],
  })
  await trusted.datasets.ingest(orders, { changes: [change.upsert({ id: "ord-1", total: 3 })] })
  await trusted.datasets.ingest(payroll, { changes: [change.upsert({ id: "emp-1", salary: 9 })] })

  const person = (id: string, groupIds: readonly string[]) =>
    createTestSixb(host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id },
        groupIds,
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })

  return {
    host,
    lakeStorage,
    trusted,
    person,
    analyst: person("usr_analyst", [analysts.id]),
    accountant: person("usr_accountant", [finance.id]),
  }
}

afterEach(() => {
  setSystemTime()
})

describe("lake slices", () => {
  // Red check: in writeLakeSlice, hold every dataset that has a version, whatever it hides.
  test("hold what their person reads in full, skip what they read in part, and never name the rest", async () => {
    const { host, lakeStorage, analyst } = await seed()

    const slice = await writeLakeSlice(host, analyst, {
      point: "point-1",
      path: "/tmp/slice",
      branch: "invoice-reminders",
    })

    const ordersVersion = await lakeStorage.getLatestVersion(orders.id)
    expect(slice.versions).toEqual([
      { datasetId: orders.id, versionId: `${ordersVersion?.versionId}` },
    ])
    expect(slice.skipped).toEqual([
      { datasetId: invoices.id, reason: "missing_clearance", columns: ["amount"] },
    ])
    expect(lakeStorage.askedAbout.sort()).toEqual([invoices.id, orders.id])
    // The producer is recorded as the reader sees it: an ingestion, without its execution.
    expect(lakeStorage.slices).toMatchObject([
      {
        point: "point-1",
        versions: slice.versions.map((version) => ({ ...version, producer: { kind: "ingest" } })),
        path: "/tmp/slice",
      },
    ])
    // The slice is recorded with its exact files.
    expect(
      (await host.storage.lakeSlices?.get({ projectId: host.id, id: slice.id }))?.files
    ).toEqual(slice.versions.map(filePath))
  })

  // Red checks: in openLakeSliceFile, drop the `files.has` check, or the expiry check.
  test("a token reads only its slice's files, and only until it expires", async () => {
    setSystemTime(new Date("2026-11-24T10:00:00.000Z"))
    const { host, accountant, lakeStorage } = await seed()
    const slice = await writeLakeSlice(host, accountant, {
      point: "point-1",
      path: "/tmp/slice",
      branch: "invoice-reminders",
    })
    const { token, expiresAt } = await issueLakeSliceToken(host, accountant, { sliceId: slice.id })
    const payrollVersion = await lakeStorage.getLatestVersion(payroll.id)
    const outside = filePath({ datasetId: payroll.id, versionId: `${payrollVersion?.versionId}` })
    const [inside] = slice.versions.map(filePath)

    expect(slice.versions.map((version) => version.datasetId).sort()).toEqual([
      invoices.id,
      orders.id,
    ])
    expect(expiresAt).toEqual(new Date("2026-11-24T10:15:00.000Z"))
    expect((await openLakeSliceFile(host, { token, path: `${inside}` })).kind).toBe("file")
    expect(await openLakeSliceFile(host, { token, path: outside })).toEqual({ kind: "not_found" })
    expect(await openLakeSliceFile(host, { token: "x".repeat(43), path: `${inside}` })).toEqual({
      kind: "unauthorized",
    })

    setSystemTime(expiresAt)
    expect(await openLakeSliceFile(host, { token, path: `${inside}` })).toEqual({
      kind: "unauthorized",
    })
  })

  // Red check: in issueLakeSliceToken, drop the loop that checks each version again.
  test("a token is issued only while its person still reads every version in full", async () => {
    const { host, accountant, analyst, person } = await seed()
    const slice = await writeLakeSlice(host, accountant, {
      point: "point-1",
      path: "/tmp/slice",
      branch: "invoice-reminders",
    })
    // The same person, since moved out of finance.
    const demoted = person("usr_accountant", [analysts.id])

    expect(
      String(await issueLakeSliceToken(host, analyst, { sliceId: slice.id }).catch((e) => e))
    ).toContain("has no lake slice")
    const refused = await issueLakeSliceToken(host, demoted, { sliceId: slice.id }).catch(
      (error) => error
    )

    expect(refused).toBeInstanceOf(Error)
    expect(String(refused)).toContain(`can no longer read version`)
    expect(String(refused)).toContain(invoices.id)
  })

  test("hold a pinned version instead of the latest, such as the one a projection applied", async () => {
    const { host, accountant, lakeStorage, trusted } = await seed()
    const applied = await lakeStorage.getLatestVersion(orders.id)
    await trusted.datasets.ingest(orders, { changes: [change.upsert({ id: "ord-2", total: 4 })] })
    const latest = await lakeStorage.getLatestVersion(orders.id)

    const slice = await writeLakeSlice(host, accountant, {
      point: "point-1",
      path: "/tmp/slice",
      branch: "order-reminders",
      pinned: [{ datasetId: orders.id, versionId: `${applied?.versionId}` }],
    })

    expect(applied?.versionId).not.toBe(latest?.versionId)
    expect(slice.versions).toContainEqual({
      datasetId: orders.id,
      versionId: `${applied?.versionId}`,
    })
  })

  // Red check: in writeLakeSlice, build `pinned` as a plain Map (the last pin wins), or skip a
  // pinned dataset whose version is gone as an unpinned one without a version.
  test("refuse two pins of one dataset, or a pinned version that no longer exists", async () => {
    const { host, accountant, lakeStorage, trusted } = await seed()
    const applied = await lakeStorage.getLatestVersion(orders.id)
    await trusted.datasets.ingest(orders, { changes: [change.upsert({ id: "ord-2", total: 4 })] })
    const latest = await lakeStorage.getLatestVersion(orders.id)
    const cut = (pinned: { datasetId: string; versionId: string }[]) =>
      writeLakeSlice(host, accountant, {
        point: "point-1",
        path: "/tmp/slice",
        branch: "order-reminders",
        pinned,
      }).catch((error) => error)

    const twice = await cut([
      { datasetId: orders.id, versionId: `${applied?.versionId}` },
      { datasetId: orders.id, versionId: `${latest?.versionId}` },
    ])
    const gone = await cut([{ datasetId: orders.id, versionId: "memory:999" }])

    expect(String(twice)).toContain(`pins '${orders.id}' at both`)
    expect(String(gone)).toContain("which no longer exists")
    expect(
      await host.storage.lakeSlices?.listLive({ projectId: host.id, liveAfter: new Date(0) })
    ).toEqual([])
  })

  test("only a person's own request cuts a slice or reads with it", async () => {
    const { host, trusted } = await seed()

    const cut = await writeLakeSlice(host, trusted, {
      point: "point-1",
      path: "/tmp/s",
      branch: "invoice-reminders",
    }).catch((error) => error)
    const issued = await issueLakeSliceToken(host, trusted, { sliceId: "lakeslice_x" }).catch(
      (error) => error
    )

    expect(String(cut)).toContain("Only a person's own request can cut a lake slice")
    expect(String(issued)).toContain("Only a person's own request")
  })

  // Red check: in renewLakeSliceToken's reader, resolve the person's groups as they were, not now.
  test("are renewed for a person outside their requests, as they read production now", async () => {
    const { host, accountant } = await seed()
    const slice = await writeLakeSlice(host, accountant, {
      point: "point-1",
      path: "/tmp/slice",
      branch: "invoice-reminders",
    })
    const auth = host.storage.auth
    if (!auth) throw new Error("The test storage keeps members")
    await auth.users.create({
      projectId: host.id,
      id: "usr_accountant",
      email: "accountant@acme.com",
    })
    await auth.groupMemberships.upsert({
      projectId: host.id,
      userId: "usr_accountant",
      groupId: finance.id,
      source: "manual",
    })
    const renew = () => renewLakeSliceToken(host, { sliceId: slice.id }).catch((error) => error)

    const renewed = await renew()
    expect(renewed.token).toHaveLength(43)
    expect(
      (
        await openLakeSliceFile(host, {
          token: renewed.token,
          path: `${slice.versions.map(filePath)[0]}`,
        })
      ).kind
    ).toBe("file")

    await auth.groupMemberships.remove({
      projectId: host.id,
      userId: "usr_accountant",
      groupId: finance.id,
    })
    expect(String(await renew())).toContain("can no longer read version")

    await auth.users.updateStatus({
      projectId: host.id,
      id: "usr_accountant",
      status: "suspended",
    })
    expect(String(await renew())).toContain("no longer an active member")
  })

  test("keep the files of slices a branch may still read", async () => {
    setSystemTime(new Date("2026-11-24T10:00:00.000Z"))
    const { host, accountant, lakeStorage } = await seed()
    const slice = await writeLakeSlice(host, accountant, {
      point: "point-1",
      path: "/tmp/slice",
      branch: "invoice-reminders",
    })
    await issueLakeSliceToken(host, accountant, { sliceId: slice.id })

    setSystemTime(new Date(Date.now() + LAKE_SLICE_KEEP_MS))
    await releaseLakeSliceFiles(host)
    setSystemTime(new Date(Date.now() + 16 * 60_000))
    await releaseLakeSliceFiles(host)

    expect(lakeStorage.releases).toEqual([
      { liveSlices: [slice.versions.map(filePath)] },
      { liveSlices: [] },
    ])
  })

  test("say which providers a branch needs", async () => {
    const { host, accountant } = await seed()
    const withoutGrants: LakeSliceHost = { ...host, id: host.id, storage: {} }
    const withoutForks: LakeSliceHost = {
      id: host.id,
      storage: host.storage,
      lakeStorage: {},
    }

    const noGrants = await issueLakeSliceToken(withoutGrants, accountant, {
      sliceId: "lakeslice_x",
    }).catch((error) => error)
    const noForks = await writeLakeSlice(withoutForks, accountant, {
      point: "point-1",
      path: "/tmp/s",
      branch: "b",
    }).catch((error) => error)

    expect(String(noGrants)).toContain("storage.lakeSlices")
    expect(String(noForks)).toContain("cannot be read from a branch")
    expect(
      await openLakeSliceFile(withoutForks, { token: "x".repeat(43), path: "a" })
    ).toMatchObject({
      kind: "unavailable",
    })
    expect(
      await openLakeSliceFile(withoutGrants, { token: "x".repeat(43), path: "a" })
    ).toMatchObject({
      kind: "unavailable",
    })
  })
})
