import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type ActionDefinition,
  type AgentDefinition,
  agents,
  can,
  canPerformMembershipOperation,
  col,
  createSixb,
  type DatasetDefinition,
  datasets,
  defineAction,
  defineAgent,
  defineConnector,
  defineDataset,
  defineGroup,
  defineMembershipPolicy,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineRole,
  defineSync,
  type GroupDefinition,
  type MembershipPolicyDefinition,
  ontology,
  type PipelineDefinition,
  pipelines,
  prop,
  type RoleDefinition,
  resolveMembershipPolicyScope,
  SecurityValidationError,
  Sixb,
  type SyncDefinition,
  syncs,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const coreModuleUrl = pathToFileURL(resolve(import.meta.dir, "..", "src", "index.ts")).href
const tempRoots = new Set<string>()

const Account = defineObjectType({
  id: "account",
  name: "Account",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const AccountSnapshot = defineDataset("account.snapshot", {
  schema: [col("id", "string")],
})

const model = {} as Parameters<typeof defineAgent>[1]["model"]

const opsAgent = defineAgent("ops", {
  name: "Ops Agent",
  model,
  instructions: "Assist operators.",
})

const sourceConnector = defineConnector("source", {
  type: "test",
  async connect() {
    return {}
  },
})

const syncAccounts = defineSync("sync-accounts")
  .from(sourceConnector)
  .read(() => [])
  .intoDataset(AccountSnapshot)

const normalizeAccountsStep = definePipelineStep("normalize-accounts")
  .inputs({ snapshot: AccountSnapshot })
  .output(AccountSnapshot)
  .run(async () => {})

const normalizeAccountsPipeline = definePipeline("normalize-accounts").then(normalizeAccountsStep)

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true })
  }
  tempRoots.clear()
})

describe("security definitions", () => {
  test("defineGroup returns a group definition", () => {
    expect(
      defineGroup("security-admins", {
        label: "Security admins",
        description: "Can manage invitations",
      })
    ).toEqual({
      kind: "group",
      id: "security-admins",
      label: "Security admins",
      description: "Can manage invitations",
    })
  })

  test("defineMembershipPolicy normalizes group definitions to ids", () => {
    const securityAdmins = defineGroup("security-admins")
    const commercial = defineGroup("commercial")
    const finance = defineGroup("finance")

    expect(
      defineMembershipPolicy("member-admin", {
        grantedTo: [securityAdmins],
        scope: [commercial, finance],
        can: ["invite", "assignGroups", "suspend"],
      })
    ).toEqual({
      kind: "membershipPolicy",
      id: "member-admin",
      grantedToGroupIds: ["security-admins"],
      scopeGroupIds: ["commercial", "finance"],
      can: ["invite", "assignGroups", "suspend"],
    })
  })

  test("defineMembershipPolicy rejects policies without operations", () => {
    const securityAdmins = defineGroup("security-admins")

    expect(() =>
      defineMembershipPolicy("empty", {
        grantedTo: [securityAdmins],
        scope: [],
        can: [],
      })
    ).toThrow(SecurityValidationError)
  })

  test("membership policy scopes combine applicable policies by operation", () => {
    const scope = resolveMembershipPolicyScope({
      callerGroupIds: ["security-admins"],
      membershipPolicies: [
        {
          kind: "membershipPolicy",
          id: "commercial-membership",
          grantedToGroupIds: ["security-admins"],
          scopeGroupIds: ["commercial"],
          can: ["invite", "assignGroups"],
        },
        {
          kind: "membershipPolicy",
          id: "finance-suspend",
          grantedToGroupIds: ["security-admins"],
          scopeGroupIds: ["finance"],
          can: ["suspend"],
        },
        {
          kind: "membershipPolicy",
          id: "groupless-invites",
          grantedToGroupIds: ["security-admins"],
          scopeGroupIds: [],
          can: ["invite"],
        },
        {
          kind: "membershipPolicy",
          id: "ignored",
          grantedToGroupIds: ["other-admins"],
          scopeGroupIds: ["engineering"],
          can: ["invite", "assignGroups", "suspend"],
        },
      ],
    })

    expect(scope.policyIds).toEqual([
      "commercial-membership",
      "finance-suspend",
      "groupless-invites",
    ])
    expect(scope.operations.invite.policyIds).toEqual([
      "commercial-membership",
      "groupless-invites",
    ])
    expect([...scope.operations.invite.groupIds]).toEqual(["commercial"])
    expect([...scope.operations.assignGroups.groupIds]).toEqual(["commercial"])
    expect([...scope.operations.suspend.groupIds]).toEqual(["finance"])
    expect(canPerformMembershipOperation(scope, "invite", ["commercial"])).toBe(true)
    expect(canPerformMembershipOperation(scope, "invite", [])).toBe(true)
    expect(canPerformMembershipOperation(scope, "invite", ["finance"])).toBe(false)
    expect(canPerformMembershipOperation(scope, "assignGroups", ["commercial"])).toBe(true)
    expect(canPerformMembershipOperation(scope, "assignGroups", [])).toBe(true)
    expect(canPerformMembershipOperation(scope, "suspend", ["finance"])).toBe(true)
    expect(canPerformMembershipOperation(scope, "suspend", ["commercial"])).toBe(false)
  })

  test("createSixb discovers membership policies from security policies folder", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "security/groups/team.ts",
      `import { defineGroup } from "${coreModuleUrl}"

export const securityAdmins = defineGroup("security-admins")
export const commercial = defineGroup("commercial")
export const finance = defineGroup("finance")
`
    )

    await writeProjectFile(
      projectRoot,
      "security/policies/member-administration.ts",
      `import { defineMembershipPolicy } from "${coreModuleUrl}"
import { commercial, finance, securityAdmins } from "../groups/team"

export const memberAdministration = defineMembershipPolicy("member-administration", {
  grantedTo: [securityAdmins],
  scope: [commercial, finance],
  can: ["invite", "assignGroups", "suspend"],
})
`
    )

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Account],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.security.getMembershipPolicyById("member-administration")).toEqual({
      kind: "membershipPolicy",
      id: "member-administration",
      grantedToGroupIds: ["security-admins"],
      scopeGroupIds: ["commercial", "finance"],
      can: ["invite", "assignGroups", "suspend"],
    })
  })

  test("explicit groups and membership policies register without filesystem discovery", async () => {
    const securityAdmins: GroupDefinition = { kind: "group", id: "security-admins" }
    const commercial: GroupDefinition = { kind: "group", id: "commercial" }
    const membershipPolicy: MembershipPolicyDefinition = {
      kind: "membershipPolicy",
      id: "member-admin",
      grantedToGroupIds: ["security-admins"],
      scopeGroupIds: ["commercial"],
      can: ["invite", "assignGroups"],
    }

    const sixb = await createSixb({
      projectRoot: await createTempProjectRoot(),
      ontologies: [Account],
      groups: [securityAdmins, commercial],
      membershipPolicies: [membershipPolicy],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.security.getGroupDefinitions()).toEqual([securityAdmins, commercial])
    expect(sixb.security.getMembershipPolicyDefinitions()).toEqual([membershipPolicy])
  })

  test("runtime registration rejects duplicate group ids", () => {
    expect(() =>
      createRuntime({
        groups: [
          { kind: "group", id: "security-admins" },
          { kind: "group", id: "security-admins" },
        ],
      })
    ).toThrow(SecurityValidationError)
  })

  test("runtime registration rejects duplicate membership policy ids", () => {
    const groups: GroupDefinition[] = [
      { kind: "group", id: "security-admins" },
      { kind: "group", id: "commercial" },
    ]
    const policy: MembershipPolicyDefinition = {
      kind: "membershipPolicy",
      id: "member-admin",
      grantedToGroupIds: ["security-admins"],
      scopeGroupIds: ["commercial"],
      can: ["invite"],
    }

    expect(() => createRuntime({ groups, membershipPolicies: [policy, policy] })).toThrow(
      SecurityValidationError
    )
  })

  test("runtime registration rejects membership policies referencing unknown groups", () => {
    expect(() =>
      createRuntime({
        groups: [{ kind: "group", id: "security-admins" }],
        membershipPolicies: [
          {
            kind: "membershipPolicy",
            id: "member-admin",
            grantedToGroupIds: ["security-admins"],
            scopeGroupIds: ["commercial"],
            can: ["invite"],
          },
        ],
      })
    ).toThrow("unknown group 'commercial'")
  })

  test("runtime registration rejects membership policies without granted groups", () => {
    expect(() =>
      createRuntime({
        groups: [{ kind: "group", id: "commercial" }],
        membershipPolicies: [
          {
            kind: "membershipPolicy",
            id: "member-admin",
            grantedToGroupIds: [],
            scopeGroupIds: ["commercial"],
            can: ["invite"],
          },
        ],
      })
    ).toThrow("must grant membership authority")
  })

  test("runtime registration rejects membership policies without operations", () => {
    expect(() =>
      createRuntime({
        groups: [{ kind: "group", id: "security-admins" }],
        membershipPolicies: [
          {
            kind: "membershipPolicy",
            id: "member-admin",
            grantedToGroupIds: ["security-admins"],
            scopeGroupIds: [],
            can: [],
          },
        ],
      })
    ).toThrow("must declare at least one operation")
  })

  test("empty security definitions remain allowed at the definition layer", () => {
    const sixb = createRuntime()

    expect(sixb.security.getGroupDefinitions()).toEqual([])
    expect(sixb.security.getRoleDefinitions()).toEqual([])
    expect(sixb.security.getMembershipPolicyDefinitions()).toEqual([])
  })
})

describe("role definitions", () => {
  const commercial = defineGroup("commercial")
  const finance = defineGroup("finance")
  const reboot = defineAction("reboot")
    .params({})
    .edits(() => {})

  test("defineRole normalizes groups and preserves grants in order", () => {
    expect(
      defineRole("contract.operator", {
        label: "Contract operator",
        grantedTo: [commercial, finance],
        grants: [can.view([Account]), can.apply(reboot)],
      })
    ).toEqual({
      kind: "role",
      id: "contract.operator",
      label: "Contract operator",
      grantedToGroupIds: ["commercial", "finance"],
      grants: [
        {
          kind: "grant",
          capability: "view",
          target: "object",
          selection: { all: false, ids: ["account"] },
        },
        { kind: "grant", capability: "apply", selection: { all: false, ids: ["reboot"] } },
      ],
    })
  })

  test("can.view dedupes ids within an explicit selection", () => {
    expect(can.view([Account, Account])).toEqual({
      kind: "grant",
      capability: "view",
      target: "object",
      selection: { all: false, ids: ["account"] },
    })
  })

  test("can.view supports dataset definitions and scopes", () => {
    expect(can.view(AccountSnapshot)).toEqual({
      kind: "grant",
      capability: "view",
      target: "dataset",
      selection: { all: false, ids: ["account.snapshot"] },
    })
    expect(can.view(datasets()).selection).toEqual({ all: true, except: [] })
    expect(can.view(datasets().except([AccountSnapshot]))).toEqual({
      kind: "grant",
      capability: "view",
      target: "dataset",
      selection: { all: true, except: ["account.snapshot"] },
    })
  })

  test("can.observe exposes the explicit project log capability", () => {
    expect(can.observe("logs")).toEqual({
      kind: "grant",
      capability: "observe",
      target: "logs",
      selection: { all: false, ids: ["logs"] },
    })
  })

  test("can.run supports sync, pipeline, and agent definitions and scopes", () => {
    expect(can.run(syncAccounts)).toEqual({
      kind: "grant",
      capability: "run",
      target: "sync",
      selection: { all: false, ids: ["sync-accounts"] },
    })
    expect(can.run(syncs()).selection).toEqual({ all: true, except: [] })
    expect(can.run(syncs().except([syncAccounts]))).toEqual({
      kind: "grant",
      capability: "run",
      target: "sync",
      selection: { all: true, except: ["sync-accounts"] },
    })
    expect(can.run(normalizeAccountsPipeline)).toEqual({
      kind: "grant",
      capability: "run",
      target: "pipeline",
      selection: { all: false, ids: ["normalize-accounts"] },
    })
    expect(can.run(pipelines()).selection).toEqual({ all: true, except: [] })
    expect(can.run(pipelines().except([normalizeAccountsPipeline]))).toEqual({
      kind: "grant",
      capability: "run",
      target: "pipeline",
      selection: { all: true, except: ["normalize-accounts"] },
    })
    expect(can.run(opsAgent)).toEqual({
      kind: "grant",
      capability: "run",
      target: "agent",
      selection: { all: false, ids: ["ops"] },
    })
    expect(can.run(agents()).selection).toEqual({ all: true, except: [] })
    expect(can.run(agents().except([opsAgent]))).toEqual({
      kind: "grant",
      capability: "run",
      target: "agent",
      selection: { all: true, except: ["ops"] },
    })
  })

  test("scopes select the whole universe, with optional exclusions", () => {
    expect(can.view(ontology.objects()).selection).toEqual({ all: true, except: [] })
    expect(can.view(ontology.objects().except([Account])).selection).toEqual({
      all: true,
      except: ["account"],
    })
  })

  test("defineRole rejects roles granted to no groups", () => {
    expect(() => defineRole("empty", { grantedTo: [], grants: [can.view(Account)] })).toThrow(
      SecurityValidationError
    )
  })

  test("defineRole rejects roles with no grants", () => {
    expect(() => defineRole("empty", { grantedTo: [commercial], grants: [] })).toThrow(
      SecurityValidationError
    )
  })

  test("defineRole rejects grant items that are not grants", () => {
    expect(() =>
      defineRole("invalid", {
        grantedTo: [commercial],
        grants: [{ kind: "group", id: "commercial" } as unknown as GroupDefinition & never],
      })
    ).toThrow("must contain only grant definitions from 'can'")
  })

  test("runtime registration rejects duplicate role ids", () => {
    const role = defineRole("contract.operator", {
      grantedTo: [commercial],
      grants: [can.view(Account)],
    })

    expect(() => createRuntime({ groups: [commercial], roles: [role, role] })).toThrow(
      "Duplicate role id"
    )
  })

  test("runtime registration rejects roles referencing unknown groups", () => {
    const role = defineRole("contract.operator", {
      grantedTo: [commercial],
      grants: [can.view(Account)],
    })

    expect(() => createRuntime({ roles: [role] })).toThrow("unknown group 'commercial'")
  })

  test("runtime registration rejects view grants on unknown object types", () => {
    const role: RoleDefinition = {
      kind: "role",
      id: "contract.operator",
      grantedToGroupIds: ["commercial"],
      grants: [
        {
          kind: "grant",
          capability: "view",
          target: "object",
          selection: { all: false, ids: ["missing"] },
        },
      ],
    }

    expect(() => createRuntime({ groups: [commercial], roles: [role] })).toThrow(
      "unknown object type 'missing'"
    )
  })

  test("runtime registration rejects view grants on unknown datasets", () => {
    const role: RoleDefinition = {
      kind: "role",
      id: "dataset.viewer",
      grantedToGroupIds: ["commercial"],
      grants: [
        {
          kind: "grant",
          capability: "view",
          target: "dataset",
          selection: { all: false, ids: ["missing"] },
        },
      ],
    }

    expect(() => createRuntime({ groups: [commercial], roles: [role] })).toThrow(
      "unknown dataset 'missing'"
    )
  })

  test("runtime registration rejects apply grants on unknown actions", () => {
    const role: RoleDefinition = {
      kind: "role",
      id: "contract.operator",
      grantedToGroupIds: ["commercial"],
      grants: [{ kind: "grant", capability: "apply", selection: { all: false, ids: ["missing"] } }],
    }

    expect(() => createRuntime({ groups: [commercial], roles: [role] })).toThrow(
      "unknown action 'missing'"
    )
  })

  test("runtime registration rejects run grants on unknown syncs", () => {
    const role: RoleDefinition = {
      kind: "role",
      id: "sync.runner",
      grantedToGroupIds: ["commercial"],
      grants: [
        {
          kind: "grant",
          capability: "run",
          target: "sync",
          selection: { all: false, ids: ["missing"] },
        },
      ],
    }

    expect(() => createRuntime({ groups: [commercial], roles: [role] })).toThrow(
      "unknown sync 'missing'"
    )
  })

  test("runtime registration rejects run grants on unknown pipelines", () => {
    const role: RoleDefinition = {
      kind: "role",
      id: "pipeline.runner",
      grantedToGroupIds: ["commercial"],
      grants: [
        {
          kind: "grant",
          capability: "run",
          target: "pipeline",
          selection: { all: false, ids: ["missing"] },
        },
      ],
    }

    expect(() => createRuntime({ groups: [commercial], roles: [role] })).toThrow(
      "unknown pipeline 'missing'"
    )
  })

  test("runtime registration rejects run grants on unknown agents", () => {
    const role: RoleDefinition = {
      kind: "role",
      id: "agent.runner",
      grantedToGroupIds: ["commercial"],
      grants: [
        {
          kind: "grant",
          capability: "run",
          target: "agent",
          selection: { all: false, ids: ["missing"] },
        },
      ],
    }

    expect(() => createRuntime({ groups: [commercial], roles: [role] })).toThrow(
      "unknown agent 'missing'"
    )
  })

  test("valid roles register and resolve from the security registry", () => {
    const role = defineRole("contract.operator", {
      grantedTo: [commercial],
      grants: [can.view(Account), can.apply(reboot)],
    })

    const sixb = createRuntime({
      groups: [commercial],
      roles: [role],
      actions: [reboot],
    })

    expect(sixb.security.getRoleDefinitions()).toEqual([role])
    expect(sixb.security.getRoleById("contract.operator")).toEqual(role)
    expect(sixb.security.getRoleById("missing")).toBeNull()
  })

  test("createSixb discovers roles from security/roles", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/account.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Account = defineObjectType({
  id: "account",
  name: "Account",
  properties: [prop("id", "string", { required: true, primary: true })],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "actions/reboot.ts",
      `import { defineAction } from "${coreModuleUrl}"

export const reboot = defineAction("reboot")
  .params({})
  .edits(() => {})
`
    )

    await writeProjectFile(
      projectRoot,
      "security/groups/team.ts",
      `import { defineGroup } from "${coreModuleUrl}"

export const commercial = defineGroup("commercial")
`
    )

    await writeProjectFile(
      projectRoot,
      "security/roles/contract-operator.ts",
      `import { can, defineRole } from "${coreModuleUrl}"
import { reboot } from "../../actions/reboot"
import { Account } from "../../ontology/account"
import { commercial } from "../groups/team"

export const contractOperator = defineRole("contract.operator", {
  grantedTo: [commercial],
  grants: [can.view(Account), can.apply(reboot)],
})
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.security.getRoleById("contract.operator")).toEqual({
      kind: "role",
      id: "contract.operator",
      grantedToGroupIds: ["commercial"],
      grants: [
        {
          kind: "grant",
          capability: "view",
          target: "object",
          selection: { all: false, ids: ["account"] },
        },
        { kind: "grant", capability: "apply", selection: { all: false, ids: ["reboot"] } },
      ],
    })
  })
})

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sixb-core-security-"))
  tempRoots.add(projectRoot)
  return projectRoot
}

function createRuntime(
  options: {
    groups?: readonly GroupDefinition[]
    roles?: readonly RoleDefinition[]
    membershipPolicies?: readonly MembershipPolicyDefinition[]
    actions?: readonly ActionDefinition[]
    datasets?: readonly DatasetDefinition[]
    syncs?: readonly SyncDefinition[]
    pipelines?: readonly PipelineDefinition[]
    agents?: readonly AgentDefinition[]
  } = {}
): Sixb<readonly [typeof Account]> {
  return new Sixb<readonly [typeof Account]>({
    ontology: [Account],
    ...options,
    ...createTestRuntimeDeps(),
  })
}

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(projectRoot, relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content, "utf-8")
}
