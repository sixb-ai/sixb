import { afterEach, describe, expect, jest, test } from "bun:test"
import type { AuthorizablePrincipal, ProjectSource, SandboxFactory } from "../src"
import { AuthorizationError, SixbHost } from "../src"
import { emptyGrantIndex } from "../src/authorization/types"
import { BranchRequestError, getProjectBranches } from "../src/branches"
import { createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const forbidden = async (): Promise<never> => {
  throw new Error("Must not create a sandbox")
}
const factory: SandboxFactory = {
  supportsRequestCredentials: true,
  create: forbidden,
  resume: forbidden,
}
const developer: AuthorizablePrincipal = { type: "user", id: "developer" }

function setup(source: ProjectSource | null = { repository: "acme/operations" }) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "project-branches",
    ontology: [],
    ...deps,
    sandboxes: { ...factory, configuration: {} },
    ...(source === null ? {} : { source }),
    models: { language: [testLanguageModel()] },
  })
  const as = (grants: { readonly source?: boolean } = { source: true }) =>
    createTestSixb(host, {
      authorization: {
        principal: developer,
        groupIds: [],
        roleIds: [],
        grants: {
          ...emptyGrantIndex(),
          "run:agent": true,
          "manage:source": grants.source ?? false,
        },
      },
    })
  const stored = (name: string) => deps.storage.branches.get({ projectId: host.id, name })
  return { as, stored }
}

describe("the project's branches", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test("opening a branch adds it, wanted running, and shows nothing that reaches its runtime", async () => {
    const { as, stored } = setup()
    const branches = getProjectBranches(as())

    const opened = await branches.open("vendor-invoices")
    expect(opened).toMatchObject({ name: "vendor-invoices", wanted: "running", state: "stopped" })
    expect(opened.createdBy).toBe("developer")
    expect(Object.keys(opened)).not.toContain("key")
    expect(Object.keys(opened)).not.toContain("url")

    const route = await branches.route("vendor-invoices")
    const key = String((await stored("vendor-invoices"))?.key)
    expect(route).toEqual({ state: "stopped", url: null, key })
    expect(route?.key).toMatch(/^[0-9a-f]{64}$/)

    expect((await branches.stop("vendor-invoices")).wanted).toBe("stopped")
    expect((await branches.open("vendor-invoices")).wanted).toBe("running")
    expect((await branches.list()).map((branch) => branch.name)).toEqual(["vendor-invoices"])
    expect(await branches.get("elsewhere")).toBeNull()
    expect(await branches.route("elsewhere")).toBeNull()
  })

  test("refuses a name git or a shell would read as something else, and a branch that isn't there", async () => {
    const branches = getProjectBranches(setup().as())
    const error = await branches.open("a;b").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BranchRequestError)
    expect((error as BranchRequestError).code).toBe("invalid_branch")

    const missing = await branches.stop("gone").catch((caught: unknown) => caught)
    expect((missing as BranchRequestError).code).toBe("branch_not_found")
  })

  test("a visit keeps the branch from stopping as idle, written at most once a minute", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-17T12:00:00.000Z") })
    const { as, stored } = setup()
    const branches = getProjectBranches(as())
    await branches.open("fix")

    jest.setSystemTime(new Date("2026-11-17T12:00:30.000Z"))
    await branches.route("fix")
    expect((await stored("fix"))?.revision).toBe(1)

    jest.setSystemTime(new Date("2026-11-17T12:01:30.000Z"))
    await branches.route("fix")
    expect(await stored("fix")).toMatchObject({
      revision: 2,
      lastSeenAt: new Date("2026-11-17T12:01:30.000Z"),
    })
  })

  test("take can.manage(project.source), and so does a thread on a branch", async () => {
    const { as } = setup()
    const outsider = as({ source: false })
    const refused = await getProjectBranches(outsider)
      .open("fix")
      .catch((caught: unknown) => caught)
    expect(refused).toBeInstanceOf(AuthorizationError)

    // Drop `assertMayWorkOnProjectBranch` from thread creation and the outsider's thread is made.
    const thread = await outsider.agent.threads
      .create({ sandbox: { branch: "fix" } })
      .catch((caught: unknown) => caught)
    expect(thread).toBeInstanceOf(AuthorizationError)
    expect((await as().agent.threads.create({ sandbox: { branch: "fix" } })).sandboxParams).toEqual(
      {
        branch: "fix",
      }
    )
  })

  test("need the project to name its source", async () => {
    const branches = getProjectBranches(setup(null).as())
    const error = await branches.list().catch((caught: unknown) => caught)
    expect((error as BranchRequestError).code).toBe("branches_unavailable")
  })
})
