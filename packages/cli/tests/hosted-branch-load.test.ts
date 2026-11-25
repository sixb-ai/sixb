import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  project,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import { branchRuntimeOf, copyForBranch, HOSTED_BRANCH_COPY } from "@sixb/core/internal/branches"
import { putOnBranch } from "@sixb/core/internal/runtime"
import { createTestSixb } from "@sixb/core/testing"
import { hostedBranchFromProduction, loadedCopyOf } from "../src/lib/branch-from-production"

// A branch production runs is the runtime `sixb dev --from production` runs on a laptop: its copy
// arrives where the supervisor would spool one, and the same load puts it in the branch's storage.

const Order = defineObjectType({
  id: "order",
  name: "Order",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const developers = defineGroup("developers")
const roles = [
  defineRole("developers", {
    grantedTo: [developers],
    grants: [can.view(Order), can.manage(project.source)],
  }),
]

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sixb-hosted-branch-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function options(storage: InMemoryStorage) {
  return {
    id: "shop",
    ontology: [Order],
    groups: [developers],
    roles,
    auth: { id: "test", kind: "dev" as const },
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  }
}

/** What production writes into the branch's sandbox: the copy, whole, and what it came from. */
async function deliverCopy(production: SixbHost) {
  const person = resolveAuthorizationContext({
    principal: { type: "user", id: "usr_bo" },
    groupIds: ["developers"],
    roles: production.definitions.security.listResolvedRoles(),
  })
  const parts: Uint8Array[] = []
  for await (const part of copyForBranch(production, {
    person,
    branch: "feature/invoices",
    requestId: "copy-1",
    directory: root,
  })) {
    parts.push(part)
  }

  const directory = join(root, ".sixb", "branches")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const spool = join(directory, `${HOSTED_BRANCH_COPY}.copy`)
  await writeFile(spool, Buffer.concat(parts), { mode: 0o600 })
  await writeFile(
    `${spool}.json`,
    JSON.stringify({
      gitBranch: "feature/invoices",
      apiUrl: "https://api.shop.test",
      profile: "production",
    }),
    { mode: 0o600 }
  )
  return spool
}

// Guard check: drop the `loadCopy` call from `hostedBranchFromProduction`: the branch has no copy.
test("loads the copy production delivered into the branch's storage, and runs on it", async () => {
  const productionStorage = new InMemoryStorage()
  const production = new SixbHost(options(productionStorage))
  await productionStorage.auth.users.create({
    projectId: "shop",
    id: "usr_bo",
    email: "bo@shop.test",
  })
  await createTestSixb(production)
    .objects(Order)
    .upsert({ properties: { id: "ord-1" } })
  const spool = await deliverCopy(production)

  const branchStorage = new InMemoryStorage()
  const loaded = new SixbHost(
    putOnBranch(options(new InMemoryStorage()), {
      name: "feature/invoices",
      dataFrom: "production",
    })
  )
  const branch = await hostedBranchFromProduction({
    host: loaded,
    projectRoot: root,
    storage: branchStorage,
    hosted: {
      key: "k".repeat(43),
      origin: "https://feature-invoices.preview.shop.test",
      productionOrigin: null,
    },
  })

  expect(branch.copied).toBe(true)
  expect(branchRuntimeOf(branch.host)).toMatchObject({
    person: { userId: "usr_bo" },
    production: { url: "https://api.shop.test" },
    hosted: { key: "k".repeat(43) },
  })
  const orders = await branchStorage.objects.list({ projectId: "shop", objectTypeId: Order.id })
  expect(orders.objects.map((order) => order.primaryId)).toEqual(["ord-1"])
  // Loaded once: the spool goes, and what it held stays for production to read.
  expect(await stat(spool).catch(() => null)).toBeNull()
  expect(await loadedCopyOf(root, HOSTED_BRANCH_COPY)).toMatchObject({
    objects: 1,
    skipped: [],
    lakeSliceId: null,
  })

  // The next generation runs on the same copy, without a spool.
  const again = await hostedBranchFromProduction({
    host: loaded,
    projectRoot: root,
    storage: branchStorage,
    hosted: {
      key: "k".repeat(43),
      origin: "https://feature-invoices.preview.shop.test",
      productionOrigin: null,
    },
  })
  expect(again.copied).toBe(false)
})

test("refuses to start without a copy production delivered", async () => {
  const loaded = new SixbHost(
    putOnBranch(options(new InMemoryStorage()), {
      name: "feature/invoices",
      dataFrom: "production",
    })
  )

  const refused = await hostedBranchFromProduction({
    host: loaded,
    projectRoot: root,
    storage: new InMemoryStorage(),
    hosted: {
      key: "k".repeat(43),
      origin: "https://feature-invoices.preview.shop.test",
      productionOrigin: null,
    },
  }).catch((error: unknown) => error)

  expect(String(refused)).toContain("has no copy of production")
})

// A refresh whose load failed once left the branch Ready on the empty schema, announcing the last
// copy. Guard check: keep the last record when a new copy arrives (`hostedBranchFromProduction`).
test("keeps no copy when a new one fails to load, and says so at the next start", async () => {
  const productionStorage = new InMemoryStorage()
  const production = new SixbHost(options(productionStorage))
  await productionStorage.auth.users.create({
    projectId: "shop",
    id: "usr_bo",
    email: "bo@shop.test",
  })
  await createTestSixb(production)
    .objects(Order)
    .upsert({ properties: { id: "ord-1" } })
  await deliverCopy(production)

  const loaded = new SixbHost(
    putOnBranch(options(new InMemoryStorage()), {
      name: "feature/invoices",
      dataFrom: "production",
    })
  )
  const start = () =>
    hostedBranchFromProduction({
      host: loaded,
      projectRoot: root,
      storage: new InMemoryStorage(),
      hosted: {
        key: "k".repeat(43),
        origin: "https://feature-invoices.preview.shop.test",
        productionOrigin: null,
      },
    })
  await start()

  // The refresh's copy arrives cut short.
  const spool = await deliverCopy(production)
  await writeFile(spool, new Uint8Array([1, 0, 0, 0]))
  expect(await start().catch((error: unknown) => error)).toBeInstanceOf(Error)

  expect(await loadedCopyOf(root, HOSTED_BRANCH_COPY)).toBeNull()
  expect(String(await start().catch((error: unknown) => error))).toContain(
    "has no copy of production"
  )
})
