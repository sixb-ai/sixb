import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  can,
  change,
  col,
  defineDataset,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryQueues,
  migrateStorage,
  project,
  prop,
  SixbHost,
  type SixbHostOptions,
  type Storage,
} from "@sixb/core"
import { branchRuntimeOf } from "@sixb/core/internal/branches"
import { putOnBranch } from "@sixb/core/internal/runtime"
import { createTestSixb } from "@sixb/core/testing"
import { DuckLakeStorage } from "@sixb/ducklake"
import { PostgresStorage } from "@sixb/pg"
import { SqliteStorage } from "@sixb/sqlite"
import { createSixbApi, SixbServer } from "../../server/src/server"
import { createTestBrowserPolicy } from "../../server/tests/helpers"
import { branchFromProduction, namespaceFor } from "../src/lib/branch-from-production"
import type { LoadedSixbHost } from "../src/lib/loadSixb"

// `sixb dev --from production` on a laptop: production runs on PostgreSQL with a DuckLake lake on
// a PostgreSQL catalog; the laptop's local storage is SQLite or PostgreSQL. Alice may copy and
// reads open tickets and the orders; Bob reads tickets but may not copy.

const COMPOSE_FILE = join(import.meta.dir, "fixtures/branch-from-production/docker-compose.yml")
const compose = ["docker", "compose", "-p", `sixb-branch-copy-${process.pid}`, "-f", COMPOSE_FILE]
const PROJECT = "branch-copy"

const Ticket = defineObjectType({
  id: "BranchTicket",
  name: "Ticket",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
    prop("title", "string"),
  ],
})
const orders = defineDataset("branch.orders", {
  schema: [col("id", "string"), col("total", "float64")],
  primaryKey: "id",
})
const developers = defineGroup("developers")
const readers = defineGroup("readers")
const roles = [
  defineRole("developers", {
    grantedTo: [developers],
    grants: [
      can.manage(project.source),
      can.view(Ticket).where((ticket) => ticket.p.status.eq("open")),
      can.view(orders),
    ],
  }),
  defineRole("readers", { grantedTo: [readers], grants: [can.view(Ticket)] }),
]

let rootDir: string
let databaseUrl: string
let production: { host: SixbHost; storage: PostgresStorage; lake: DuckLakeStorage; url: string }
let server: ReturnType<typeof Bun.serve>

function hostOptions(storage: Storage, lake: DuckLakeStorage): SixbHostOptions {
  return {
    id: PROJECT,
    ontology: [Ticket],
    datasets: [orders],
    groups: [developers, readers],
    roles,
    storage,
    lakeStorage: lake,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    auth: { id: "test", kind: "dev" },
  }
}

async function dockerCompose(args: string[]): Promise<string> {
  const proc = Bun.spawn([...compose, ...args], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 120_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr)
    return stdout.trim()
  } finally {
    clearTimeout(timer)
  }
}

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "sixb-branch-copy-"))
  await dockerCompose(["up", "-d", "--wait"])
  const port = Number((await dockerCompose(["port", "postgres", "5432"])).split(":").at(-1))
  databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/postgres`

  const storage = new PostgresStorage({ connectionString: databaseUrl, schemaName: "production" })
  await migrateStorage(storage)
  const lake = new DuckLakeStorage({
    catalog: {
      type: "postgres",
      host: "127.0.0.1",
      port,
      database: "postgres",
      user: "postgres",
      password: "test",
      metadataSchema: "production_lake",
    },
    dataPath: join(rootDir, "production-lake"),
  })
  const host = new SixbHost(hostOptions(storage, lake))
  await migrateStorage(storage, {
    projectId: PROJECT,
    ontology: host.definitions.ontology as never,
  })

  const trusted = createTestSixb(host)
  for (const [id, status] of [
    ["t-1", "open"],
    ["t-2", "closed"],
    ["t-3", "open"],
  ] as const) {
    await trusted.objects(Ticket).upsert({ properties: { id, status, title: `Ticket ${id}` } })
  }
  await trusted.datasets.ingest(orders, {
    changes: [change.upsert({ id: "o-1", total: 10 }), change.upsert({ id: "o-2", total: 20 })],
  })
  for (const [userId, groupId] of [
    ["usr_alice", developers.id],
    ["usr_bob", readers.id],
  ] as const) {
    await storage.auth.users.create({ projectId: PROJECT, id: userId, email: `${userId}@x.test` })
    await storage.auth.groupMemberships.upsert({
      projectId: PROJECT,
      userId,
      groupId,
      source: "manual",
    })
  }

  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) })
  production = { host, storage, lake, url: server.url.toString() }
}, 180_000)

afterAll(async () => {
  server?.stop(true)
  await production?.lake.close()
  await production?.storage.close()
  await dockerCompose(["down", "-v", "--remove-orphans"])
  await rm(rootDir, { recursive: true, force: true })
}, 180_000)

/** Production, read as `userId` through the CLI session `sixb login` would hold. */
async function signedIn(userId: string) {
  const { session, tokens } = production.host.auth.prepareBearerSession({
    userId,
    clientName: "sixb CLI",
    now: new Date(),
  })
  await production.storage.auth.sessions.create(session)
  return { apiUrl: production.url, authorization: async () => `Bearer ${tokens.accessToken}` }
}

const laptops: readonly [string, (directory: string) => Promise<Storage>][] = [
  ["SQLite", async (directory) => new SqliteStorage({ path: join(directory, "storage") })],
  [
    "PostgreSQL",
    async (directory) =>
      new PostgresStorage({
        connectionString: databaseUrl,
        schemaName: `laptop_${directory
          .split("-")
          .at(-1)!
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")}`,
      }),
  ],
]

describe.each(laptops)("a laptop branch on %s", (_name, localStorage) => {
  async function laptop() {
    const projectRoot = await mkdtemp(join(rootDir, "laptop-"))
    const storage = await localStorage(projectRoot)
    await migrateStorage(storage)
    const lake = new DuckLakeStorage({
      catalog: { type: "duckdb", path: join(projectRoot, "lake.ducklake") },
      dataPath: join(projectRoot, "lake"),
    })
    // As `sixb dev --from production` loads the project: on the branch, with its own providers.
    const host = new SixbHost(
      putOnBranch(hostOptions(storage, lake), { name: "feature/x", dataFrom: "production" })
    ) as unknown as LoadedSixbHost
    return { projectRoot, storage, lake, host }
  }

  const ticketsOn = async (host: LoadedSixbHost) =>
    (
      await createTestSixb(host as never)
        .objects(Ticket)
        .query()
        .list()
    ).objects
      .map((row) => `${row.properties.id}:${row.properties.title}`)
      .sort()

  // Red checks: in branch-from-production.ts, copy whatever namespace exists (drop the reuse),
  // skip the git-branch check in the drop loop, or drop the refresh from it.
  test("copies what the person reads once, reuses it, refreshes it, and drops it with its git branch", async () => {
    const local = await laptop()
    const alice = await signedIn("usr_alice")
    const open = (gitBranch: string, gitBranches: string[], refresh = false) =>
      branchFromProduction({
        host: local.host,
        projectRoot: local.projectRoot,
        production: alice,
        gitBranch,
        gitBranches,
        refresh,
      })

    const first = await open("feature/x", ["feature/x", "main"])
    expect(first.copied).toBe(true)
    expect(first.namespace).toBe(namespaceFor("feature/x"))
    expect(first.lake).toBe("in place")
    expect(branchRuntimeOf(first.host)?.person.userId).toBe("usr_alice")
    // Only what Alice reads: the closed ticket stays in production.
    expect(await ticketsOn(first.host)).toEqual(["t-1:Ticket t-1", "t-3:Ticket t-3"])
    // The orders are read in place, through production's file route.
    const rows: unknown[] = []
    for await (const row of first.host.lakeStorage.readRows({ datasetId: orders.id }))
      rows.push(row)
    expect(rows).toHaveLength(2)

    // The branch's own edit stays on the next run.
    await createTestSixb(first.host as never)
      .objects(Ticket)
      .upsert({ properties: { id: "t-1", status: "open", title: "Edited on the branch" } })
    await first.host.lakeStorage.close?.()
    const second = await open("feature/x", ["feature/x", "main"])
    expect(second.copied).toBe(false)
    expect(await ticketsOn(second.host)).toEqual(["t-1:Edited on the branch", "t-3:Ticket t-3"])

    // A refresh discards it.
    await second.host.lakeStorage.close?.()
    const refreshed = await open("feature/x", ["feature/x", "main"], true)
    expect(refreshed.copied).toBe(true)
    expect(await ticketsOn(refreshed.host)).toEqual(["t-1:Ticket t-1", "t-3:Ticket t-3"])

    // Once the git branch is deleted, the next run drops its copy, here and in production.
    await refreshed.host.lakeStorage.close?.()
    const live = async () =>
      (await production.storage.lakeSlices.listLive({ projectId: PROJECT, liveAfter: new Date(0) }))
        .length
    const slices = await live()
    const onMain = await open("main", ["main"])
    expect(onMain.dropped).toEqual(["feature/x"])
    expect(
      await (
        local.storage as never as { listBranchNamespaces(): Promise<string[]> }
      ).listBranchNamespaces()
    ).toEqual([namespaceFor("main")])
    expect(await live()).toBe(slices)

    await onMain.host.lakeStorage.close?.()
    await local.lake.close()
    await local.storage.close?.()
  }, 120_000)

  // Red check: drop the grant check from `copyForBranch` and the route.
  test("refuses a person who may not copy", async () => {
    const local = await laptop()
    const refused = await branchFromProduction({
      host: local.host,
      projectRoot: local.projectRoot,
      production: await signedIn("usr_bob"),
      gitBranch: "feature/x",
      gitBranches: ["feature/x"],
    }).catch((error: unknown) => error)

    expect(String(refused)).toContain("can.manage(project.source)")
    await local.lake.close()
    await local.storage.close?.()
  }, 60_000)
})
