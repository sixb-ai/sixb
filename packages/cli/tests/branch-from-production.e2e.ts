import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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
import {
  branchFromProduction,
  fetchBranchCopy,
  namespaceOf,
} from "../src/lib/branch-from-production"
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
    ["usr_dave", developers.id],
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
    // As `sixb dev --from production` does: the supervisor fetches, the branch's process loads.
    const open = async (gitBranch: string, gitBranches: string[], refresh = false) => {
      await fetchBranchCopy({
        projectRoot: local.projectRoot,
        gitBranch,
        refresh,
        profile: "alice",
        connect: async () => alice,
      })
      return branchFromProduction({
        host: local.host,
        projectRoot: local.projectRoot,
        gitBranch,
        gitBranches,
      })
    }

    const first = await open("feature/x", ["feature/x", "main"])
    expect(first.copied).toBe(true)
    expect(first.namespace).toBe(await namespaceOf(local.projectRoot, "feature/x"))
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
    ).toEqual([await namespaceOf(local.projectRoot, "main")])
    expect(await live()).toBe(slices)

    await onMain.host.lakeStorage.close?.()
    await local.lake.close()
    await local.storage.close?.()
  }, 120_000)

  // Red check: in branch-from-production.ts, make `branchesDirectory` a plain `mkdir` and drop
  // the modes the files are written with: the umask leaves the copy readable by everyone.
  test("keeps production's data readable by its owner only, from its first byte", async () => {
    const local = await laptop()
    const alice = await signedIn("usr_alice")
    const previous = process.umask(0o022)
    try {
      await fetchBranchCopy({
        projectRoot: local.projectRoot,
        gitBranch: "feature/x",
        refresh: false,
        profile: "alice",
        connect: async () => alice,
      })
      const branches = join(local.projectRoot, ".sixb/branches")
      expect(await modesOpenToOthers(branches)).toEqual([])

      const opened = await branchFromProduction({
        host: local.host,
        projectRoot: local.projectRoot,
        gitBranch: "feature/x",
        gitBranches: ["feature/x"],
      })
      expect((await readdir(branches, { recursive: true })).length).toBeGreaterThan(3)
      expect(await modesOpenToOthers(branches)).toEqual([])
      await opened.host.lakeStorage.close?.()
    } finally {
      process.umask(previous)
      await local.lake.close()
      await local.storage.close?.()
    }
  }, 120_000)

  // Red check: in `fetchBranchCopy`, reuse whatever copy exists, whoever is signed in.
  test("reuses a copy only for the profile that took it", async () => {
    const local = await laptop()
    const alice = await signedIn("usr_alice")
    const fetch = (profile: string, refresh = false) =>
      fetchBranchCopy({
        projectRoot: local.projectRoot,
        gitBranch: "feature/x",
        refresh,
        profile,
        connect: async () => alice,
      })
    expect(await fetch("alice")).toBe(true)
    await branchFromProduction({
      host: local.host,
      projectRoot: local.projectRoot,
      gitBranch: "feature/x",
      gitBranches: ["feature/x"],
    }).then((opened) => opened.host.lakeStorage.close?.())

    // Reusing needs no network: a connection would throw.
    expect(
      await fetchBranchCopy({
        projectRoot: local.projectRoot,
        gitBranch: "feature/x",
        profile: "alice",
        connect: async () => {
          throw new Error("offline")
        },
      })
    ).toBe(false)
    expect(String(await fetch("bob").catch((error: unknown) => error))).toContain(
      "taken as alice, and you are signed in as bob"
    )
    expect(await fetch("bob", true)).toBe(true)
    await local.lake.close()
    await local.storage.close?.()
  }, 60_000)

  // Red check: in routes/branches.ts, drop the grant check of the copy route alone: the copy
  // starts and breaks off. (`copyForBranch`'s own is `packages/core/tests/branch-copy.test.ts`'s.)
  test("refuses a person who may not copy", async () => {
    const local = await laptop()
    const bob = await signedIn("usr_bob")
    const refused = await fetchBranchCopy({
      projectRoot: local.projectRoot,
      gitBranch: "feature/x",
      profile: "bob",
      connect: async () => bob,
    }).catch((error: unknown) => error)

    expect(String(refused)).toContain("can.manage(project.source)")
    await local.lake.close()
    await local.storage.close?.()
  }, 60_000)
})

// The developer's own path: `sixb dev --from production` in a git checkout, against production.
describe("sixb dev --from production", () => {
  const cli = resolve(import.meta.dir, "../src/index.tsx")

  /**
   * A project checked out on `feature/x`, laid out as the template: SQLite at `.sixb`, which keeps
   * a branch's namespace in `.sixb/branches/<name>/` beside the CLI's files, and DuckLake.
   */
  async function checkout() {
    const scratch = resolve(import.meta.dir, "../../../.local")
    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, "dev-from-production-"))
    await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir")
    const write = async (path: string, source: string) => {
      await mkdir(resolve(join(root, path), ".."), { recursive: true })
      await writeFile(join(root, path), source)
    }
    await write(
      "ontology/Ticket.ts",
      `import { defineObjectType, prop } from "@sixb/core"
export const Ticket = defineObjectType({ id: "BranchTicket", name: "Ticket", properties: [
  prop("id", "string", { primary: true, required: true }),
  prop("status", "string", { query: { searchable: true, filterable: true } }),
  prop("title", "string"),
] })
`
    )
    await write(
      "sixb.config.ts",
      `import { mkdirSync } from "node:fs"
import { can, col, createSixb, defineDataset, defineGroup, defineRole, InMemoryBlobStorage,
  InMemoryBroker, InMemoryQueues, project } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { migrateSqliteStorage, SqliteStorage } from "@sixb/sqlite"
import { Ticket } from "./ontology/Ticket"
mkdirSync(import.meta.dir + "/.sixb/lake", { recursive: true })
const orders = defineDataset("branch.orders", { schema: [col("id", "string"), col("total", "float64")], primaryKey: "id" })
const developers = defineGroup("developers")
const readers = defineGroup("readers")
await migrateSqliteStorage(import.meta.dir + "/.sixb")
export const sixb = await createSixb({
  id: "branch-copy", projectRoot: import.meta.dir,
  broker: new InMemoryBroker(), queues: new InMemoryQueues(), blobStorage: new InMemoryBlobStorage(),
  storage: new SqliteStorage({ path: import.meta.dir + "/.sixb" }),
  lakeStorage: new DuckLakeStorage({ catalog: { type: "duckdb", path: import.meta.dir + "/.sixb/lake/metadata.ducklake" }, dataPath: import.meta.dir + "/.sixb/lake/data" }),
  datasets: [orders], groups: [developers, readers],
  roles: [
    defineRole("developers", { grantedTo: [developers], grants: [can.manage(project.source),
      can.view(Ticket).where((ticket) => ticket.p.status.eq("open")), can.view(orders)] }),
    defineRole("readers", { grantedTo: [readers], grants: [can.view(Ticket)] }),
  ],
})
// What the branch's code is given of the developer's production sign-in.
const signIn = ["SIXB_API_URL", "SIXB_API_TOKEN", "SIXB_TOKEN", "SIXB_PROFILE"].filter((name) => process.env[name] !== undefined)
await Bun.write(import.meta.dir + "/.sixb/sign-in-seen.json", JSON.stringify(signIn))
await Bun.write(import.meta.dir + "/.sixb/runtime-seen.txt", process.env.SIXB_BRANCH_RUNTIME ?? "")
`
    )
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "."],
      ["-c", "user.email=dev@x.test", "-c", "user.name=dev", "commit", "-qm", "project"],
      ["checkout", "-q", "-b", "feature/x"],
    ]) {
      await run(["git", ...args], root)
    }
    return root
  }

  async function run(command: string[], cwd: string) {
    const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => proc.kill(), 30_000)
    try {
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      if (code !== 0) throw new Error(`${command.join(" ")}: ${stderr}`)
    } finally {
      clearTimeout(timer)
    }
  }

  function freePort(): number {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = Number(server.port)
    server.stop(true)
    return port
  }

  /** One `sixb dev --from production` until it is ready: its output, its API, and how to stop it. */
  async function dev(root: string, token: string, args: string[] = []) {
    const port = freePort()
    const apiPort = freePort()
    let output = ""
    const proc = Bun.spawn(
      [
        process.execPath,
        cli,
        "dev",
        "--from",
        "production",
        "--port",
        String(port),
        "--api-port",
        String(apiPort),
        ...args,
      ],
      {
        cwd: root,
        // The developer's CLI sign-in in production, and a home of its own: no other profile.
        env: {
          ...process.env,
          HOME: root,
          SIXB_API_URL: production.url,
          SIXB_API_TOKEN: token,
          SIXB_TOKEN: token,
        },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      }
    )
    const capture = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) output += decoder.decode(chunk, { stream: true })
    }
    const readers = [capture(proc.stdout), capture(proc.stderr)]
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 90_000)
    const stop = async () => {
      proc.kill("SIGTERM")
      const kill = setTimeout(() => proc.kill("SIGKILL"), 12_000)
      await proc.exited
      clearTimeout(kill)
      clearTimeout(deadline)
      await Promise.all(readers)
    }

    const started = Date.now()
    while (!/\[SixbDev\] Ready/.test(output)) {
      if (proc.exitCode !== null || Date.now() - started > 60_000) {
        await stop()
        throw new Error(`sixb dev did not start:\n${output}`)
      }
      await Bun.sleep(50)
    }
    return { api: `http://127.0.0.1:${apiPort}`, output: () => output, stop }
  }

  const tickets = async (api: string) => {
    const response = await fetch(`${api}/api/objects?objectTypeId=BranchTicket`)
    const body = (await response.json()) as { objects: { properties: Record<string, string> }[] }
    return body.objects.map((object) => `${object.properties.id}:${object.properties.title}`).sort()
  }

  /** Edit t-1 straight in the branch's SQLite file, as the branch's own write would land. */
  async function editOnBranch(root: string) {
    const directory = join(root, ".sixb/branches", await namespaceOf(root, "feature/x"))
    const db = new Database(join(directory, "storage.sqlite"))
    db.run(
      "UPDATE objects SET properties = json_set(properties, '$.title', 'Edited on the branch') WHERE primary_id = 't-1'"
    )
    db.close()
  }

  // Red checks: in commands/dev-runner.ts, start the project's own host instead of the branch's:
  // the API serves the laptop's empty storage. In commands/dev.ts, leave `refresh` out of
  // `fetchBranchCopy`: --refresh reuses the copy, as it once did before this test found it; drop
  // the loop over `PRODUCTION_SIGN_IN_ENV`: the branch's code reads the developer's token; drop
  // `BRANCH_RUNTIME_ENV`: the branch runs as no checkout in particular. In
  // lib/branch-from-production.ts, empty the branch's whole directory in `loadCopy` again: the
  // template's SQLite namespace in it goes, and the second run has no copy.
  test("copies, serves the copy as the person, reuses it, refreshes it, and drops it with its git branch", async () => {
    const root = await checkout()
    const alice = (await signedIn("usr_alice")).authorization
    const token = (await alice()).slice("Bearer ".length)
    try {
      const first = await dev(root, token)
      // The supervisor's startup deadline waits for the load, and says so (`dev-supervisor.test.ts`).
      expect(first.output()).toContain("[SixbDev] Loading this branch's copy of production's data")
      expect(first.output()).toContain("Branch: production's data as you read it, copied now")
      expect(first.output()).toContain("Off on this branch")
      expect(await Bun.file(join(root, ".sixb/sign-in-seen.json")).json()).toEqual([])
      // Who runs the branch: this checkout, apart from the same git branch run anywhere else.
      expect(await Bun.file(join(root, ".sixb/runtime-seen.txt")).text()).toBe(
        (await Bun.file(join(root, ".sixb/branches/checkout")).text()).trim()
      )
      // Served as Alice: the closed ticket stays in production.
      expect(await tickets(first.api)).toEqual(["t-1:Ticket t-1", "t-3:Ticket t-3"])
      await first.stop()

      await editOnBranch(root)
      const second = await dev(root, token)
      expect(second.output()).not.toContain("copied now")
      expect(second.output()).not.toContain("Loading this branch's copy")
      expect(await tickets(second.api)).toEqual(["t-1:Edited on the branch", "t-3:Ticket t-3"])
      await second.stop()

      const refreshed = await dev(root, token, ["--refresh"])
      expect(refreshed.output()).toContain("copied now")
      expect(await tickets(refreshed.api)).toEqual(["t-1:Ticket t-1", "t-3:Ticket t-3"])
      await refreshed.stop()

      // Back on main with feature/x deleted: the next run drops its copy.
      await run(["git", "checkout", "-q", "main"], root)
      await run(["git", "branch", "-q", "-D", "feature/x"], root)
      const onMain = await dev(root, token)
      expect(onMain.output()).toContain("Dropped the copy of deleted git branch feature/x")
      await onMain.stop()
      const branches = await readdir(join(root, ".sixb/branches"))
      expect(branches).toContain(await namespaceOf(root, "main"))
      expect(branches).not.toContain(await namespaceOf(root, "feature/x"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})

describe("production's copy route", () => {
  // Red check: in routes/branches.ts, drop the copies-running limit. (That a copy cut short leaves
  // no slice is `packages/core/tests/branch-copy.test.ts`'s; a copy that never started, the
  // server's `branch-runtime.test.ts`.)
  test("runs two copies at a time, one per person, and a branch that goes away frees its place", async () => {
    const alice = await signedIn("usr_alice")
    const dave = await signedIn("usr_dave")
    const live = async () =>
      (await production.storage.lakeSlices.listLive({ projectId: PROJECT, liveAfter: new Date(0) }))
        .length
    const before = await live()
    const copy = async (person = alice, signal?: AbortSignal) =>
      fetch(new URL("api/branches/copy", production.url), {
        method: "POST",
        headers: {
          authorization: await person.authorization(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ branch: "feature/limit" }),
        ...(signal ? { signal } : {}),
      })

    const goneFirst = new AbortController()
    const goneSecond = new AbortController()
    const first = await copy(alice, goneFirst.signal)
    // Alice's second copy waits for her first, whoever else copies.
    const again = await copy(alice)
    const second = await copy(dave, goneSecond.signal)
    const third = await copy(dave)
    expect([first.status, again.status, second.status, third.status]).toEqual([200, 429, 200, 429])
    expect(await again.text()).toContain("Your copy to a branch is still running")

    // Both branches go away before reading their copies through: their places come back.
    await first.body!.getReader().read()
    goneFirst.abort()
    goneSecond.abort()
    let next = await copy()
    for (const deadline = Date.now() + 10_000; next.status === 429 && Date.now() < deadline; ) {
      await Bun.sleep(25)
      next = await copy()
    }
    expect(next.status).toBe(200)
    await next.arrayBuffer()

    expect(await live()).toBe(before + 1)
  }, 60_000)
})

describe("a copy the supervisor fetches", () => {
  // Red checks: in branch-from-production.ts, drop `confirmReceived`: the slice is never confirmed,
  // and lapses within the hour. Drop the release of the unloaded spool's slice: the first copy's
  // slice stays live, holding production's files two weeks.
  test("is confirmed once held whole, and a copy fetched again before loading releases it", async () => {
    const projectRoot = await mkdtemp(join(rootDir, "supervisor-"))
    const alice = await signedIn("usr_alice")
    const slices = async () =>
      (
        await production.storage.lakeSlices.listLive({ projectId: PROJECT, liveAfter: new Date(0) })
      ).filter((slice) => slice.branch === "feature/spooled")
    const fetchCopy = () =>
      fetchBranchCopy({
        projectRoot,
        gitBranch: "feature/spooled",
        refresh: true,
        profile: "alice",
        connect: async () => alice,
      })

    await fetchCopy()
    const [first] = await slices()
    expect(first?.receivedAt).toBeInstanceOf(Date)

    await fetchCopy()
    const [second, ...more] = await slices()
    expect(more).toEqual([])
    expect(second?.id).not.toBe(first?.id)
    expect(second?.receivedAt).toBeInstanceOf(Date)
  }, 60_000)
})

/** The directory and every entry under it that its owner's group or anyone else may open. */
async function modesOpenToOthers(directory: string): Promise<string[]> {
  const entries = ["", ...(await readdir(directory, { recursive: true }))]
  const open: string[] = []
  for (const entry of entries) {
    const mode = (await stat(join(directory, entry))).mode & 0o777
    if (mode & 0o077) open.push(`${entry || "."} ${mode.toString(8)}`)
  }
  return open
}
