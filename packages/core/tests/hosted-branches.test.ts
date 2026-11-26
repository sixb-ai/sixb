import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  project,
  prop,
  resolveAuthorizationContext,
  SixbHost,
  type SixbHostOptions,
} from "../src"
import { putOnBranch } from "../src/branch-mode"
import { branchNamespaceName } from "../src/branches"
import { InMemoryStorage } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { groupsOf } from "./helpers/view-conditions"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A shop: Bo manages orders; payroll is someone else's. What `sixb.branches` lets Bo ask for: a
// branch worker does the work (`@sixb/branch-worker`), and `branch-data.test.ts` covers the copy.

const projectId = "hosted-branches"
const BRANCH = { name: "feature/invoices", dataFrom: "production" } as const

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
  defineRole("staff", {
    grantedTo: [defineGroup("staff")],
    grants: [can.view(Order), can.manage(project.source)],
  }),
  defineRole("payroll", { grantedTo: [defineGroup("payroll")], grants: [can.view(Payslip)] }),
]

function hostOptions(overrides: Partial<SixbHostOptions> = {}): SixbHostOptions {
  return {
    id: projectId,
    ontology: [Order, Payslip],
    groups: groupsOf(roles),
    roles,
    source: { repository: "acme/shop" },
    ...createTestRuntimeDeps(),
    ...overrides,
  }
}

/**
 * In memory there is no instance to host a role on: a namespace stands for the branch's schema.
 * `@sixb/pg`'s own tests and the branch worker's e2e run the real one.
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
  const host = new SixbHost(hostOptions({ storage: hosting(new InMemoryStorage()), ...overrides }))
  const auth = host.storage.auth

  await auth?.users.create({ projectId, id: "usr_bo", email: "bo@example.com" })
  await auth?.groupMemberships.upsert({
    projectId,
    userId: "usr_bo",
    groupId: "staff",
    source: "manual",
  })

  const trusted = createTestSixb(host)
  await trusted.objects(Order).upsert({ properties: { id: "ord-1", total: 120 } })
  await trusted.objects(Order).upsert({ properties: { id: "ord-2", total: 80 } })
  await trusted.objects(Payslip).upsert({ properties: { id: "pay-1" } })

  return host
}

function as(host: SixbHost, groupIds: readonly string[]) {
  const authorization: AuthorizationContext = resolveAuthorizationContext({
    principal: { type: "user", id: "usr_bo" },
    groupIds,
    roles: host.definitions.security.listResolvedRoles(),
  })
  return createTestSixb(host, { authorization })
}

describe("sixb.branches", () => {
  test("opens a branch once, with its own namespace and key, and keeps the key to production", async () => {
    const host = await deploy()
    const branches = as(host, ["staff"]).branches

    const opened = await branches.open(BRANCH.name)
    const again = await branches.open(BRANCH.name)
    const row = await host.storage.hostedBranches?.get({ projectId, name: BRANCH.name })

    expect(opened).toMatchObject({
      name: BRANCH.name,
      wanted: "running",
      state: "stopped",
      createdBy: "usr_bo",
    })
    expect(opened).not.toHaveProperty("key")
    expect(row).toMatchObject({
      namespace: branchNamespaceName(BRANCH.name),
      // Drawn by the worker, with the sandbox it serves in.
      port: null,
      revision: 2,
    })
    expect(row?.key).toHaveLength(43)
    expect(again.openedAt.getTime()).toBeGreaterThanOrEqual(opened.openedAt.getTime())
    expect((await branches.list()).map((branch) => branch.name)).toEqual([BRANCH.name])
  })

  test("asks for a refresh, a stop and a delete", async () => {
    const host = await deploy()
    const branches = as(host, ["staff"]).branches
    await branches.open(BRANCH.name)

    expect((await branches.refresh(BRANCH.name)).refreshRequestedAt).toBeInstanceOf(Date)
    expect((await branches.stop(BRANCH.name)).wanted).toBe("stopped")
    expect((await branches.delete(BRANCH.name)).wanted).toBe("deleted")

    for (const late of [branches.open, branches.refresh, branches.stop]) {
      const refused = await late(BRANCH.name).catch((error: unknown) => error)
      expect(String(refused)).toContain("is being deleted")
    }
    expect(String(await branches.stop("missing").catch((error: unknown) => error))).toContain(
      "There is no branch 'missing'"
    )
  })

  // A stop read the row, then wrote over it after a delete landed: the branch came back stopped,
  // with its schema dropped under it.
  // Guard check: drop `revision` from the update in `want` (`branches/execution.ts`).
  test("never writes over a row that moved on after it was read", async () => {
    const host = await deploy()
    const branches = as(host, ["staff"]).branches
    await branches.open(BRANCH.name)

    const rows = host.storage.hostedBranches!
    const update = rows.update.bind(rows)
    let raced = false
    rows.update = async (input, changes) => {
      if (!raced && changes.wanted === "stopped") {
        raced = true
        await update({ projectId, name: BRANCH.name, at: new Date() }, { wanted: "deleted" })
      }
      return update(input, changes)
    }

    const refused = await branches.stop(BRANCH.name).catch((error: unknown) => error)

    expect(String(refused)).toContain("is being deleted")
    expect((await rows.get({ projectId, name: BRANCH.name }))?.wanted).toBe("deleted")
  })

  // Guard check: drop `assertMayManageBranches` from `store` in `branches/execution.ts`.
  test("takes the console's grant", async () => {
    const host = await deploy()

    const refused = await as(host, ["payroll"])
      .branches.open(BRANCH.name)
      .catch((error: unknown) => error)

    expect(String(refused)).toContain("not allowed")
    expect(await host.storage.hostedBranches?.list({ projectId })).toEqual([])
  })

  test("needs a person, a repository and a git branch name", async () => {
    const noSource = await deploy({ source: undefined })
    const host = await deploy()

    expect(
      String(
        await as(noSource, ["staff"])
          .branches.open("x")
          .catch((e: unknown) => e)
      )
    ).toContain("name it with createSixb({ source: { repository } })")
    expect(
      String(
        await createTestSixb(host)
          .branches.open("x")
          .catch((e: unknown) => e)
      )
    ).toContain("only a person opens one")
    expect(
      String(
        await as(host, ["staff"])
          .branches.open("../x")
          .catch((e: unknown) => e)
      )
    ).toContain("is a git branch name")
  })

  // Guard check: drop the `runtime.branch` refusal from `store` in `branches/execution.ts`.
  test("are opened in production, not from another branch", async () => {
    const branch = new SixbHost(putOnBranch(hostOptions(), BRANCH))

    const refused = await as(branch, ["staff"])
      .branches.open("other")
      .catch((e: unknown) => e)

    expect(String(refused)).toContain(
      'Branch "feature/invoices": branches are opened in production'
    )
  })
})
