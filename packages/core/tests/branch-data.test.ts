import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  prop,
  SixbHost,
  type SixbHostOptions,
} from "../src"
import {
  branchNamespaceName,
  dropBranchData,
  hostBranchDatabase,
  prepareBranchData,
} from "../src/branches"
import { branchNamespaces } from "../src/snapshots"
import { type BranchRecord, InMemoryStorage } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { groupsOf } from "./helpers/view-conditions"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A shop: Bo reads orders, not payslips. Production's side of a branch Bo opened: a schema made
// anew for each copy, for the branch's runtime to load its copy into.

const projectId = "branch-data"
const NAME = "feature/invoices"

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

const roles = [
  defineRole("staff", { grantedTo: [defineGroup("staff")], grants: [can.view(Order)] }),
  defineRole("payroll", { grantedTo: [defineGroup("payroll")], grants: [can.view(Payslip)] }),
]

/**
 * In memory there is no instance to host a role on: a namespace stands for the branch's schema.
 * `@sixb/pg`'s own tests run the real one.
 */
function hosting(storage: InMemoryStorage): InMemoryStorage {
  return Object.assign(storage, {
    createHostedBranch: async (name: string) => {
      await storage.createBranchNamespace(name)
      return { tempFileLimit: true }
    },
    openHostedBranch: async (name: string) => ({
      url: "postgres://role@db/prod",
      schemaName: name,
    }),
    dropHostedBranch: (name: string) => storage.dropBranchNamespace(name),
    enforceHostedBranchLimits: async () => 0,
  })
}

async function deploy(overrides: Partial<SixbHostOptions> = {}) {
  const host = new SixbHost({
    id: projectId,
    ontology: [Order, Payslip],
    groups: groupsOf(roles),
    roles,
    ...createTestRuntimeDeps(),
    storage: hosting(new InMemoryStorage()),
    ...overrides,
  })
  await host.storage.auth?.users.create({ projectId, id: "usr_bo", email: "bo@example.com" })
  await host.storage.auth?.groupMemberships.upsert({
    projectId,
    userId: "usr_bo",
    groupId: "staff",
    source: "manual",
  })

  const trusted = createTestSixb(host)
  await trusted.objects(Order).upsert({ properties: { id: "ord-1", total: 120 } })
  await trusted.objects(Order).upsert({ properties: { id: "ord-2", total: 80 } })
  await trusted.objects(Payslip).upsert({ properties: { id: "pay-1" } })

  const { branch } = await host.storage.hostedBranches!.create(row())
  return { host, branch }
}

function row(): Omit<BranchRecord, "updatedAt" | "revision"> {
  const at = new Date("2026-11-24T12:00:00.000Z")
  return {
    projectId,
    name: NAME,
    namespace: branchNamespaceName(NAME),
    wanted: "running",
    state: "stopped",
    createdBy: "usr_bo",
    key: "k".repeat(43),
    port: null,
    sandbox: null,
    url: null,
    generation: null,
    commit: null,
    error: null,
    data: null,
    refreshRequestedAt: null,
    remoteCommit: null,
    notices: [],
    owner: null,
    leaseExpiresAt: null,
    createdAt: at,
    openedAt: at,
    lastSeenAt: at,
  }
}

describe("a branch's data", () => {
  // Guard check: drop the `dropHostedBranch` before `createHostedBranch` in `prepareBranchData`
  // (`branches/data.ts`): the second home finds the namespace and fails.
  test("lives in a schema made anew, and empty, for each copy", async () => {
    const { host, branch } = await deploy()
    const namespaces = branchNamespaces(host.storage)

    await prepareBranchData(host, branch)
    const schema = (await namespaces.openBranchNamespace(branch.namespace))!
    await createTestSixb(host)
      .objects(Order)
      .upsert({ properties: { id: "ord-9" } })
    expect((await schema.objects.list({ projectId, objectTypeId: Order.id })).objects).toEqual([])

    await prepareBranchData(host, branch)
    expect(await namespaces.openBranchNamespace(branch.namespace)).not.toBeNull()

    await dropBranchData(host, branch)
    expect(await namespaces.openBranchNamespace(branch.namespace)).toBeNull()
  })

  test("runs on production's PostgreSQL only", async () => {
    const { host, branch } = await deploy({ storage: new InMemoryStorage() })

    const refused = await hostBranchDatabase(host, branch).catch((error: unknown) => error)

    expect(String(refused)).toContain("Use @sixb/pg for production's storage")
  })
})
