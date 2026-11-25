import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { RedisBroker } from "@sixb/broker-redis"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  InMemoryQueues,
  project,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import { BRANCH_STATUS_PATH } from "@sixb/core/internal/branches"
import { createTestSixb } from "@sixb/core/testing"
import { PostgresStorage } from "@sixb/pg"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { BranchWorker } from "../src"

// Production on PostgreSQL and Redis, its repository a git origin on this machine, and the branch
// run for real: cloned in a local sandbox, its own `sixb dev` on its database on production's
// instance, as the role limited to it.

const projectId = "shop"
const NAME = "feature/invoices"
const READY_MS = 120_000

const Order = defineObjectType({
  id: "order",
  name: "Order",
  properties: [prop("id", "string", { required: true, primary: true }), prop("total", "integer")],
})
const Payslip = defineObjectType({
  id: "payslip",
  name: "Payslip",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const Shipment = defineObjectType({
  id: "shipment",
  name: "Shipment",
  properties: [prop("id", "string", { required: true, primary: true }), prop("weight", "integer")],
})
const staff = defineRole("staff", {
  grantedTo: [defineGroup("staff")],
  grants: [can.view(Order), can.view(Shipment), can.manage(project.source)],
})

/** The project's configuration; on the branch, a shipment's weight became text. */
const config = (weight: "integer" | "string") => `import { RedisBroker } from "@sixb/broker-redis"
import {
  can, createSixb, defineGroup, defineObjectType, defineRole, project, prop,
  InMemoryBlobStorage, InMemoryLakeStorage, InMemoryQueues, InMemoryStorage,
} from "@sixb/core"

const Order = defineObjectType({
  id: "order",
  name: "Order",
  properties: [prop("id", "string", { required: true, primary: true }), prop("total", "integer")],
})
const Payslip = defineObjectType({
  id: "payslip",
  name: "Payslip",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const Shipment = defineObjectType({
  id: "shipment",
  name: "Shipment",
  properties: [prop("id", "string", { required: true, primary: true }), prop("weight", "${weight}")],
})
// The branch runs as its creator, under its own code's grants.
const staff = defineGroup("staff")
const roles = [
  defineRole("staff", {
    grantedTo: [staff],
    grants: [can.view(Order), can.view(Shipment), can.manage(project.source)],
  }),
]

// Off production, a laptop's providers: a hosted branch runs on the ones production gives it.
export default createSixb({
  id: "shop",
  ontologies: [Order, Payslip, Shipment],
  groups: [staff],
  roles,
  broker: new RedisBroker({ connection: { url: process.env.REDIS_URL } }),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
})
`

let directory: string
let origin: string
let production: SixbHost
let storage: PostgresStorage
let worker: BranchWorker
let admin: InstanceType<typeof Bun.SQL>

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await Bun.$`git ${args}`.cwd(cwd).quiet()).stdout.toString().trim()
}

const commit = (cwd: string, message: string) =>
  git(
    cwd,
    "-c",
    "user.email=e2e@sixb.test",
    "-c",
    "user.name=e2e",
    "commit",
    "--quiet",
    "-m",
    message
  )

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sixb-hosted-branch-"))
  origin = join(directory, "origin.git")
  const work = join(directory, "work")

  // The project, with this repo's packages as its dependencies, on `main` and on the branch.
  await git(directory, "init", "--quiet", "--bare", "--initial-branch=main", origin)
  await git(directory, "clone", "--quiet", origin, work)
  await writeFile(join(work, "sixb.config.ts"), config("integer"))
  await symlink(resolve(import.meta.dir, "../node_modules"), join(work, "node_modules"))
  await writeFile(join(work, ".gitignore"), ".sixb/\n")
  await git(work, "add", "-A")
  await commit(work, "project")
  await git(work, "push", "--quiet", "origin", "main")

  await git(work, "checkout", "--quiet", "-b", NAME)
  await writeFile(join(work, "sixb.config.ts"), config("string"))
  await git(work, "add", "-A")
  await commit(work, "shipments weigh in text")
  await git(work, "push", "--quiet", "origin", NAME)

  admin = new Bun.SQL(process.env.DATABASE_URL!)
  // Production hosts branches only on a database closed to PUBLIC: a branch's role could
  // connect to it otherwise.
  await admin`REVOKE CONNECT ON DATABASE postgres FROM PUBLIC`
  await admin`GRANT CONNECT ON DATABASE postgres TO postgres`
  storage = new PostgresStorage({
    connectionString: process.env.DATABASE_URL,
    schemaName: "shop_prod",
  })
  production = new SixbHost({
    id: projectId,
    ontology: [Order, Payslip, Shipment],
    groups: [defineGroup("staff")],
    roles: [staff],
    source: { repository: origin },
    sandboxes: new LocalSandboxFactory({ isolation: "none" }),
    storage,
    broker: new RedisBroker({ connection: { url: process.env.REDIS_URL } }),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  for (const migrator of storage.migrators) await migrator.migrate()

  await storage.auth.users.create({ projectId, id: "usr_bo", email: "bo@example.com" })
  await storage.auth.groupMemberships.upsert({
    projectId,
    userId: "usr_bo",
    groupId: "staff",
    source: "manual",
  })
  const trusted = createTestSixb(production)
  await trusted.objects(Order).upsert({ properties: { id: "ord-1", total: 120 } })
  await trusted.objects(Order).upsert({ properties: { id: "ord-2", total: 80 } })
  await trusted.objects(Payslip).upsert({ properties: { id: "pay-1" } })
  await trusted.objects(Shipment).upsert({ properties: { id: "shp-1", weight: 3 } })

  // The branch's dev values: what reaches its runtime, and nothing of production's.
  worker = new BranchWorker(production, {
    apiPublicOrigin: "http://127.0.0.1:1",
    devEnv: async () => ({ REDIS_URL: process.env.REDIS_URL! }),
  })
  await worker.start()
}, 120_000)

afterAll(async () => {
  await worker?.stop()
  await storage?.dropSchema()
  await storage?.close()
  await admin?.close()
  await rm(directory, { recursive: true, force: true })
}, 60_000)

const bo = () =>
  createTestSixb(production, {
    authorization: resolveAuthorizationContext({
      principal: { type: "user", id: "usr_bo" },
      groupIds: ["staff"],
      roles: production.definitions.security.listResolvedRoles(),
    }),
  })

const row = () => storage.hostedBranches.get({ projectId, name: NAME })

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = READY_MS) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value)}`)
    await Bun.sleep(250)
  }
}

/** Bo signed into the branch, as "Open branch" in production does: the cookies the branch set. */
async function signedIn(): Promise<string> {
  const { url } = await bo().branches.signIn(NAME)
  const response = await fetch(url, { redirect: "manual" })
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ")
}

/** What the branch's own API answers Bo, through its front, on the branch's own session. */
async function branchOrders(): Promise<readonly string[]> {
  const branch = (await row())!
  const response = await fetch(new URL("/api/objects?objectTypeId=order&limit=50", branch.url!), {
    headers: { cookie: await signedIn() },
  })
  const body = (await response.json()) as { objects: { primaryId: string }[] }
  return body.objects.map((object) => object.primaryId).sort()
}

describe("a branch production runs", () => {
  test(
    "serves the git branch's code on a copy of what its creator reads",
    async () => {
      await bo().branches.open(NAME)

      const ready = await until(
        row,
        (branch) => branch?.state === "ready" || branch?.state === "failed"
      )

      expect(ready?.error).toBeNull()
      expect(ready).toMatchObject({ state: "ready", data: { objects: 2 } })
      expect(ready?.notices).toEqual([])
      // Payslips are unreadable to Bo; shipments no longer fit the branch's own definitions.
      expect(ready?.data?.skipped.map((skip) => skip.objectTypeId).sort()).toEqual([
        Payslip.id,
        Shipment.id,
      ])
      expect(await branchOrders()).toEqual(["ord-1", "ord-2"])

      // Without a session of the branch's, nobody reads it; only production reads its status.
      const anonymous = await fetch(new URL("/api/objects?objectTypeId=order", ready!.url!))
      expect(anonymous.status).toBe(401)
      const status = await fetch(new URL(BRANCH_STATUS_PATH, ready!.url!))
      expect(status.status).toBe(401)
    },
    READY_MS + 10_000
  )

  test(
    "signs Bo in through production, on the branch's own origin, and counts his use",
    async () => {
      const before = (await row())!
      const { url } = await bo().branches.signIn(NAME)
      expect(new URL(url).origin).toBe(new URL(before.url!).origin)

      const signIn = await fetch(url, { redirect: "manual" })
      const cookie = signIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ")
      const session = (await (
        await fetch(new URL("/api/auth/session", before.url!), { headers: { cookie } })
      ).json()) as { user?: { id: string } }
      expect(session.user?.id).toBe("usr_bo")

      // A code is good once.
      expect((await fetch(url, { redirect: "manual" })).status).toBe(400)

      // Live updates and agent streams reach the page: its sockets sign in with its session.
      for (const channel of ["events", "agents"]) {
        const socket = new WebSocket(`${before.url!.replace(/^http/, "ws")}/ws/${channel}`, {
          headers: { cookie, origin: new URL(before.url!).origin },
        } as never)
        const first = await new Promise<string>((resolve, reject) => {
          socket.addEventListener("message", (event) => resolve(String(event.data)))
          socket.addEventListener("close", (event) => reject(new Error(`closed ${event.code}`)))
        })
        socket.close()
        expect(JSON.parse(first)).toMatchObject({ type: "connected", channel })
      }

      // Real traffic on the branch's origin keeps it up: the worker reads it from the front.
      const seen = await until(row, (branch) => branch!.lastSeenAt > before.lastSeenAt)
      expect(seen?.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime())
    },
    READY_MS
  )

  test("reaches its own database only, as its role", async () => {
    const branch = (await row())!
    const roles = await admin<{ rolname: string; rolconnlimit: number; rolconfig: string[] }[]>`
      SELECT rolname, rolconnlimit, rolconfig FROM pg_roles WHERE rolname LIKE 'sixb_branch_%'
    `
    expect(roles).toHaveLength(1)
    expect(roles[0]).toMatchObject({ rolconnlimit: 5 })
    expect(roles[0]?.rolconfig).toContain("statement_timeout=900000")
    expect(roles[0]?.rolconfig).toContain("idle_in_transaction_session_timeout=60000")

    const [owner] = await admin<{ owner: string }[]>`
      SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ${roles[0]!.rolname}
    `
    expect(owner?.owner).toBe(roles[0]?.rolname)
    expect(roles[0]!.rolname).toBe(await storage.hostedBranchRole(branch.namespace))
  })

  test(
    "reloads the code a push brings, and keeps its data",
    async () => {
      const before = (await row())!
      const work = join(directory, "push")
      await git(directory, "clone", "--quiet", "--branch", NAME, origin, work)
      await writeFile(join(work, "sixb.config.ts"), `${config("string")}\n// Invoices come next.\n`)
      await git(work, "add", "-A")
      await commit(work, "push")
      await git(work, "push", "--quiet", "origin", NAME)
      const pushed = await git(work, "rev-parse", "HEAD")

      // The worker's mirror sees the commit, the branch pulls it, its runtime restarts on it.
      const pulled = await until(
        row,
        (branch) => branch?.commit === pushed && branch.state === "ready"
      )

      expect(pulled?.remoteCommit).toBe(pushed)
      expect(pulled?.data?.takenAt).toEqual(before.data?.takenAt)
      expect(await branchOrders()).toEqual(["ord-1", "ord-2"])
    },
    READY_MS
  )

  test(
    "takes a new copy on refresh, and drops what the branch wrote",
    async () => {
      const before = (await row())!
      expect(await branchOrders()).toEqual(["ord-1", "ord-2"])

      // The branch writes an order of its own; production gets a new one meanwhile.
      // As the instance's superuser, in the branch's own database under production's schema
      // name: the test's stand-in for the branch's own writes.
      const database = new URL(process.env.DATABASE_URL!)
      database.pathname = `/${await storage.hostedBranchRole(before.namespace)}`
      const namespace = new PostgresStorage({
        connectionString: database.toString(),
        schemaName: "shop_prod",
      })
      const onBranch = new SixbHost({
        id: projectId,
        ontology: [Order, Payslip, Shipment],
        storage: namespace,
        broker: new RedisBroker({ connection: { url: process.env.REDIS_URL } }),
        lakeStorage: new InMemoryLakeStorage(),
        blobStorage: new InMemoryBlobStorage(),
        queues: new InMemoryQueues(),
      })
      await createTestSixb(onBranch)
        .objects(Order)
        .upsert({ properties: { id: "ord-branch", total: 1 } })
      await namespace.close()
      expect(await branchOrders()).toEqual(["ord-1", "ord-2", "ord-branch"])
      await createTestSixb(production)
        .objects(Order)
        .upsert({ properties: { id: "ord-3", total: 10 } })

      await bo().branches.refresh(NAME)
      await until(
        row,
        (branch) => (branch?.data?.takenAt.getTime() ?? 0) > (before.data?.takenAt.getTime() ?? 0)
      )
      await until(row, (branch) => branch?.state === "ready")

      expect(await until(branchOrders, (ids) => ids.length === 3)).toEqual([
        "ord-1",
        "ord-2",
        "ord-3",
      ])
    },
    READY_MS
  )

  test(
    "drops its sandbox, its database and its role once its git branch is deleted",
    async () => {
      const branch = (await row())!
      await git(origin, "branch", "--quiet", "-D", NAME)

      await until(row, (current) => current === null)
      const left = await admin`SELECT 1 FROM pg_roles WHERE rolname LIKE 'sixb_branch_%'`
      const databases = await admin`SELECT 1 FROM pg_database WHERE datname LIKE 'sixb_branch_%'`

      expect(left).toHaveLength(0)
      expect(databases).toHaveLength(0)
      expect(await fetch(branch.url!).catch(() => null)).toBeNull()
    },
    READY_MS
  )
})
