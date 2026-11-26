import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  can,
  change,
  col,
  defineDataset,
  defineGroup,
  defineMarking,
  defineRole,
  migrateStorage,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import { issueLakeSliceToken, writeLakeSlice } from "@sixb/core/internal/lake-slices"
import {
  exportSnapshot,
  hostSnapshotSource,
  type SnapshotLakeSlice,
} from "@sixb/core/internal/snapshots"
import type { DatasetRow } from "@sixb/core/lake-storage"
import { createTestSixb } from "@sixb/core/testing"
import { SQL } from "bun"
import { DuckLakeStorage } from "../../../storage/ducklake/src"
import { PostgresStorage } from "../../../storage/pg/src"
import { createTestingScope } from "../../core/src/execution/scopes"
import { decodeSnapshot, type SnapshotRecord } from "../../core/src/snapshots/format"
import { createTestRuntimeDeps } from "../../core/tests/test-runtime-deps"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// The read path of a branch: production cuts the slice of what one person reads in full, its API
// serves the slice's files to the slice token, and a branch lake attached to the slice reads
// production's rows in place. Production's lake runs on a PostgreSQL catalog, as in production.

const financial = defineMarking("financial")
const orders = defineDataset("erp.orders", {
  schema: [col("id", "string"), col("customer", "string"), col("total", "float64")],
  primaryKey: "id",
})
const invoices = defineDataset("erp.invoices", {
  schema: [col("id", "string"), col("amount", "decimal", { markings: [financial] })],
  primaryKey: "id",
})
const payroll = defineDataset("hr.payroll", {
  schema: [col("id", "string"), col("salary", "float64")],
  primaryKey: "id",
})
const staff = defineGroup("staff")
const finance = defineGroup("finance")
const financeClearance = defineRole("finance-clearance", {
  grantedTo: [finance],
  clearances: [financial],
})
const reader = defineRole("reader", {
  grantedTo: [staff],
  grants: [can.view(orders), can.view(invoices)],
})

const id = randomUUID().replaceAll("-", "_")
const storageSchema = `lake_slices_${id}`
const lakeSchema = `lake_slices_catalog_${id}`
let rootDir: string
let storage: PostgresStorage
let production: DuckLakeStorage
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("Run server E2E tests with bun run test:e2e to provision the test database")
  }
  rootDir = await mkdtemp(join(tmpdir(), "sixb-lake-slices-"))
  storage = new PostgresStorage({
    connectionString: process.env.DATABASE_URL,
    schemaName: storageSchema,
    max: 2,
  })
  await migrateStorage(storage)

  const database = new URL(process.env.DATABASE_URL)
  production = new DuckLakeStorage({
    catalog: {
      type: "postgres",
      host: database.hostname,
      port: Number(database.port),
      database: database.pathname.slice(1),
      user: decodeURIComponent(database.username),
      password: decodeURIComponent(database.password),
      metadataSchema: lakeSchema,
    },
    dataPath: join(rootDir, "production"),
  })
}, 60_000)

afterAll(async () => {
  await server?.stop(true)
  await production?.close()
  await storage?.close()
  const sql = new SQL({ url: process.env.DATABASE_URL, max: 1 })
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${storageSchema}" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${lakeSchema}" CASCADE`)
  } finally {
    await sql.close()
  }
  await rm(rootDir, { recursive: true, force: true })
  setSystemTime()
})

describe("a branch reads production's datasets in place", () => {
  test("exact rows of what its person reads in full, through the slice file route", async () => {
    setSystemTime(new Date("2026-11-24T10:00:00.000Z"))
    const host = productionHost()
    await seed(host)
    const app = createSixbApi(
      new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
    )
    server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) })
    const filesUrl = new URL("api/lake/slice-files/", server.url).toString()

    // Production: the slice of what Alice reads in full, and her token.
    const alice = createTestSixb(host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id: "usr_alice" },
        groupIds: [staff.id],
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })
    const point = await production.forks.currentPoint()
    const slicePath = join(rootDir, "branch", "lake.ducklake")
    await Bun.write(join(rootDir, "branch", ".keep"), "")
    const slice = await writeLakeSlice(host, alice, {
      point,
      path: slicePath,
      branch: "order-reminders",
    })
    const { token, expiresAt } = await issueLakeSliceToken(host, alice, { sliceId: slice.id })
    await commitAfterPoint(host)

    const ordersVersion = slice.versions.find((version) => version.datasetId === orders.id)
    expect(slice.versions.map((version) => version.datasetId)).toEqual([orders.id])
    expect(slice.skipped).toEqual([
      { datasetId: invoices.id, reason: "missing_clearance", columns: ["amount"] },
    ])

    // The branch: the slice as its own catalog, production's files read through the route.
    const branch = new DuckLakeStorage({
      catalog: { type: "duckdb", path: slicePath },
      dataPath: join(rootDir, "branch", "data"),
      productionFiles: {
        url: filesUrl,
        token: () => token,
        cacheDirectory: join(rootDir, "branch", "cache"),
      },
    })
    try {
      expect((await branch.listDatasets()).map((dataset) => dataset.id)).toEqual([orders.id])
      expect(await branch.getDataset(invoices.id)).toBeNull()
      expect(await branch.getDataset(payroll.id)).toBeNull()

      const rows = await sorted(branch.readRows({ datasetId: orders.id }))
      expect(rows).toEqual(
        await sorted(
          production.readRows({ datasetId: orders.id, versionId: `${ordersVersion?.versionId}` })
        )
      )
      expect(rows.length).toBe(2_000 - 300 - 2 + 3)
      expect(rows.some((row) => row.includes("after the point"))).toBe(false)
    } finally {
      await branch.close()
    }

    // A file of a dataset outside the slice is refused to the same token.
    const files = async (id: string) =>
      (await host.storage.lakeSlices?.get({ projectId: host.id, id }))?.files ?? []
    // The invoices' files, as a slice of someone cleared for them would serve them.
    const bob = createTestSixb(host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id: "usr_bob" },
        groupIds: [staff.id, finance.id],
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })
    const bobs = await writeLakeSlice(host, bob, {
      point,
      path: join(rootDir, "bob.ducklake"),
      branch: "b",
    })
    const alices = await files(slice.id)
    const [inside] = alices
    const outside = (await files(bobs.id)).find((path) => !alices.includes(path))
    const authorization = `Bearer ${token}`
    expect(outside).toBeDefined()
    expect(
      (await fetch(new URL(`${outside}`, filesUrl), { headers: { authorization } })).status
    ).toBe(404)
    expect(
      (await fetch(new URL(`${inside}`, filesUrl), { headers: { authorization } })).status
    ).toBe(200)

    // Once expired, the token reads nothing: neither the route nor a branch without a cache.
    setSystemTime(expiresAt)
    expect(
      (await fetch(new URL(`${inside}`, filesUrl), { headers: { authorization } })).status
    ).toBe(401)
    const logged = spyOn(console, "error").mockImplementation(() => undefined)
    const late = new DuckLakeStorage({
      catalog: { type: "duckdb", path: slicePath },
      dataPath: join(rootDir, "late", "data"),
      productionFiles: {
        url: filesUrl,
        token: () => token,
        cacheDirectory: join(rootDir, "late", "cache"),
      },
    })
    try {
      const refused = await sorted(late.readRows({ datasetId: orders.id })).catch((error) => error)
      expect(refused).toBeInstanceOf(Error)
    } finally {
      logged.mockRestore()
      await late.close()
    }
  }, 60_000)
})

describe("a snapshot for a branch", () => {
  // Red check: in export.ts `cutLakeSlice`, cut at a point of its own (`currentLakePoint` again)
  // rather than the snapshot's: the commit landing meanwhile is then in the slice, a moment after
  // the objects'.
  test("cuts the lake slice at the moment of its objects, whatever the lake commits meanwhile", async () => {
    const host = productionHost()
    await seed(host)
    const scope = createTestingScope({
      projectId: host.id,
      context: resolveAuthorizationContext({
        principal: { type: "user", id: "usr_alice" },
        groupIds: [staff.id],
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })

    // A dataset commit lands right after the snapshot took the lake's point, inside its read.
    const forks = production.forks
    const currentPoint = forks.currentPoint.bind(forks)
    let committed = false
    forks.currentPoint = async () => {
      const point = await currentPoint()
      if (!committed) {
        committed = true
        await commitAfterPoint(host)
      }
      return point
    }
    const slicePath = join(rootDir, "snapshot.ducklake")
    let cut: SnapshotLakeSlice | undefined
    const records: SnapshotRecord[] = []
    try {
      const snapshot = exportSnapshot(hostSnapshotSource(host), {
        scope,
        lake: {
          path: slicePath,
          branch: "order-reminders",
          onSlice: (slice) => {
            cut = slice
          },
        },
      })
      for await (const record of decodeSnapshot(snapshot)) records.push(record)
    } finally {
      forks.currentPoint = currentPoint
    }

    const manifest = records.find((record) => record.kind === "manifest")
    const version = cut?.slice.versions.find((held) => held.datasetId === orders.id)
    expect(manifest?.kind === "manifest" && manifest.lake?.catalogVersion).toBe(cut?.slice.point)
    expect(cut?.token.token).toBeString()

    // The slice holds the version of the snapshot's moment; the commit after it is production's
    // latest, and only there.
    const atPoint = await production.forks.versionsAt({
      point: `${cut?.slice.point}`,
      datasetIds: [orders.id],
    })
    const latest = await production.getLatestVersion(orders.id)
    expect(version?.versionId).toBe(`${atPoint.get(orders.id)?.versionId}`)
    expect(latest?.versionId).not.toBe(version?.versionId)
    const late = await sorted(production.readRows({ datasetId: orders.id }))
    expect(late.some((row) => row.includes("after the point"))).toBe(true)
  }, 60_000)

  // Red check: in export.ts `takeSnapshot`, drop the deletion of the slice when the read fails:
  // the failed snapshot's slice then stays live, holding production's files for two weeks.
  test("leaves no slice when it fails", async () => {
    const host = productionHost()
    const scope = createTestingScope({
      projectId: host.id,
      context: resolveAuthorizationContext({
        principal: { type: "user", id: "usr_alice" },
        groupIds: [staff.id],
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })
    const live = async () =>
      (await storage.lakeSlices.listLive({ projectId: host.id, liveAfter: new Date(0) })).length
    const before = await live()

    const snapshot = exportSnapshot(hostSnapshotSource(host), {
      scope,
      lake: {
        path: join(rootDir, "failed.ducklake"),
        branch: "order-reminders",
        onSlice: () => {
          throw new Error("the branch is gone")
        },
      },
    })
    const failed = await (async () => {
      for await (const _ of decodeSnapshot(snapshot)) void _
    })().catch((error: unknown) => error)

    expect(String(failed)).toContain("the branch is gone")
    expect(await live()).toBe(before)
  }, 60_000)

  // Red check: in export.ts `cutLakeSlice`, drop the `dropLakeSlice` call when the token fails:
  // the slice, whose cut had succeeded, stays live.
  test("deletes the slice it cut when its token cannot be issued", async () => {
    const host = productionHost()
    const scope = createTestingScope({
      projectId: host.id,
      context: resolveAuthorizationContext({
        principal: { type: "user", id: "usr_alice" },
        groupIds: [staff.id],
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })
    const live = async () =>
      (await storage.lakeSlices.listLive({ projectId: host.id, liveAfter: new Date(0) })).length
    const before = await live()

    const createGrant = storage.lakeSlices.createGrant.bind(storage.lakeSlices)
    storage.lakeSlices.createGrant = async () => {
      throw new Error("no grant today")
    }
    try {
      const snapshot = exportSnapshot(hostSnapshotSource(host), {
        scope,
        lake: { path: join(rootDir, "tokenless.ducklake"), branch: "b", onSlice: () => undefined },
      })
      const failed = await (async () => {
        for await (const _ of decodeSnapshot(snapshot)) void _
      })().catch((error: unknown) => error)

      expect(String(failed)).toContain("no grant today")
    } finally {
      storage.lakeSlices.createGrant = createGrant
    }
    expect(await live()).toBe(before)
  }, 60_000)
})

describe("a branch's change read across a pinned slice", () => {
  // On a PostgreSQL catalog with history, as in production. Red check: cut the slice without
  // `pinned`: it holds the latest version, and production's applied one is unknown to the branch.
  test("reads only the branch's change, from production's version", async () => {
    const host = productionHost()
    await seed(host)
    const app = createSixbApi(
      new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
    )
    const route = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) })
    const alice = createTestSixb(host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id: "usr_alice" },
        groupIds: [staff.id],
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })

    // A projection applied this version; production wrote another since.
    const applied = await production.getLatestVersion(orders.id)
    await commitAfterPoint(host)
    const slicePath = join(rootDir, "pinned.ducklake")
    const slice = await writeLakeSlice(host, alice, {
      point: await production.forks.currentPoint(),
      path: slicePath,
      branch: "pinned",
      pinned: [{ datasetId: orders.id, versionId: `${applied?.versionId}` }],
    })
    const { token } = await issueLakeSliceToken(host, alice, { sliceId: slice.id })
    const branch = new DuckLakeStorage({
      catalog: { type: "duckdb", path: slicePath },
      dataPath: join(rootDir, "pinned", "data"),
      productionFiles: {
        url: new URL("api/lake/slice-files/", route.url).toString(),
        token: () => token,
        cacheDirectory: join(rootDir, "pinned", "cache"),
      },
    })
    try {
      const merge = await branch.beginMerge({ dataset: orders })
      await merge.writeChanges([change.upsert({ id: "ord-branch", customer: "branch", total: 1 })])
      const committed = await merge.commit()
      expect(committed.version?.versionId).toBe("ducklake:branch:1")

      const changes = await branch.readChanges({
        datasetId: orders.id,
        fromVersionId: `${applied?.versionId}`,
        toVersionId: "ducklake:branch:1",
        keyColumns: ["id"],
        columns: ["id", "customer", "total"],
      })
      const read: unknown[] = []
      for await (const row of changes?.changes ?? []) read.push(row.after ?? row.before)
      await changes?.close()

      expect(read).toEqual([{ id: "ord-branch", customer: "branch", total: 1 }])
      expect(changes?.changeCount).toBe(1)
    } finally {
      await branch.close()
      route.stop(true)
    }
  }, 60_000)
})

function productionHost(): SixbHost {
  return new SixbHost({
    ...createTestRuntimeDeps(),
    id: "lake-slices-e2e",
    ontology: [],
    datasets: [orders, invoices, payroll],
    markings: [financial],
    groups: [staff, finance],
    roles: [reader, financeClearance],
    storage,
    lakeStorage: production,
    auth: { id: "test", kind: "dev" },
  })
}

/** Orders with rows in files, deleted rows, and rows inlined in the catalog; invoices in a file. */
async function seed(host: SixbHost): Promise<void> {
  const trusted = createTestSixb(host)
  await trusted.datasets.ingest(orders, {
    changes: Array.from({ length: 2_000 }, (_, index) =>
      change.upsert({ id: `ord-${index}`, customer: `customer-${index % 25}`, total: index })
    ),
  })
  await trusted.datasets.ingest(orders, {
    changes: Array.from({ length: 300 }, (_, index) => change.delete({ id: `ord-${index * 5}` })),
  })
  await trusted.datasets.ingest(orders, {
    changes: [
      change.delete({ id: "ord-1" }),
      change.delete({ id: "ord-2" }),
      ...["a", "b", "c"].map((suffix) =>
        change.upsert({ id: `ord-new-${suffix}`, customer: "inlined", total: 1 })
      ),
    ],
  })
  await trusted.datasets.ingest(invoices, {
    changes: Array.from({ length: 50 }, (_, index) =>
      change.upsert({ id: `inv-${index}`, amount: `${index}.50` })
    ),
  })
  await trusted.datasets.ingest(payroll, { changes: [change.upsert({ id: "emp-1", salary: 1 })] })
}

async function commitAfterPoint(host: SixbHost): Promise<void> {
  await createTestSixb(host).datasets.ingest(orders, {
    changes: [
      change.upsert({ id: `ord-late-${randomUUID()}`, customer: "after the point", total: 0 }),
    ],
  })
}

async function sorted(rows: AsyncIterable<DatasetRow>): Promise<string[]> {
  const lines: string[] = []
  for await (const row of rows) lines.push(JSON.stringify(row))
  return lines.sort()
}
