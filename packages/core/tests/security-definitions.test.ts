import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type ActionDefinition,
  type AgentDefinition,
  applications,
  can,
  col,
  createSixb,
  type DatasetDefinition,
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
  every,
  type GroupDefinition,
  type MembershipPolicyDefinition,
  type PipelineDefinition,
  prop,
  type RoleDefinition,
  SecurityValidationError,
  SixbHost,
  type SyncDefinition,
} from "../src"
import { canPerformMembershipOperation, resolveMembershipPolicyScope } from "../src/security"
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

    expect(sixb.definitions.security.getMembershipPolicyById("member-administration")).toEqual({
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

    expect(sixb.definitions.security.listGroups()).toEqual([securityAdmins, commercial])
    expect(sixb.definitions.security.listMembershipPolicies()).toEqual([membershipPolicy])
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

    expect(sixb.definitions.security.listGroups()).toEqual([])
    expect(sixb.definitions.security.listRoles()).toEqual([])
    expect(sixb.definitions.security.listMembershipPolicies()).toEqual([])
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

  test("can.access grants browser applications", () => {
    expect(can.access([applications.atlas, applications.app])).toEqual({
      kind: "grant",
      capability: "access",
      target: "application",
      selection: { all: false, ids: ["atlas", "app"] },
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
    expect(can.view(every.dataset()).selection).toEqual({ all: true, except: [] })
    expect(can.view(every.dataset().except([AccountSnapshot]))).toEqual({
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
    expect(can.run(every.sync()).selection).toEqual({ all: true, except: [] })
    expect(can.run(every.sync().except([syncAccounts]))).toEqual({
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
    expect(can.run(every.pipeline()).selection).toEqual({ all: true, except: [] })
    expect(can.run(every.pipeline().except([normalizeAccountsPipeline]))).toEqual({
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
    expect(can.run(every.agent()).selection).toEqual({ all: true, except: [] })
    expect(can.run(every.agent().except([opsAgent]))).toEqual({
      kind: "grant",
      capability: "run",
      target: "agent",
      selection: { all: true, except: ["ops"] },
    })
  })

  test("can.edit and can.append build object-type write grants without a target field", () => {
    // No `target`, like `can.apply`: the capability names its one target family, so the builder
    // resolves against `["object"]` and discards the result rather than storing a redundant field.
    expect(can.edit(Account)).toEqual({
      kind: "grant",
      capability: "edit",
      selection: { all: false, ids: ["account"] },
    })
    expect(can.append(Account)).toEqual({
      kind: "grant",
      capability: "append",
      selection: { all: false, ids: ["account"] },
    })

    expect(can.edit(every.object()).selection).toEqual({ all: true, except: [] })
    expect(can.edit(every.object().except([Account])).selection).toEqual({
      all: true,
      except: ["account"],
    })
    expect(can.append(every.object()).selection).toEqual({ all: true, except: [] })
  })

  test("the write builders reject the wrong target family", () => {
    expect(() => can.edit(every.dataset() as never)).toThrow(
      "[Sixb] can.edit accepts object selectors, but received every.dataset()."
    )
    expect(() => can.append(every.action() as never)).toThrow(
      "[Sixb] can.append accepts object selectors, but received every.action()."
    )
    expect(() => can.edit(syncAccounts as never)).toThrow(
      "[Sixb] can.edit accepts object definitions, but received one targeting sync."
    )
    expect(() => can.append(AccountSnapshot as never)).toThrow(
      "[Sixb] can.append accepts object definitions, but received one targeting dataset."
    )
  })

  test("scopes select the whole universe, with optional exclusions", () => {
    expect(can.view(every.object()).selection).toEqual({ all: true, except: [] })
    expect(can.view(every.object().except([Account])).selection).toEqual({
      all: true,
      except: ["account"],
    })
  })

  test("a breadth selector from the wrong family is rejected, not silently granted", () => {
    // Typing already blocks this from TypeScript. The runtime check is what protects an untyped
    // caller, or an `as never`, from turning `can.apply` into a grant over every object type.
    expect(() => can.apply(every.object() as never)).toThrow(
      "[Sixb] can.apply accepts action selectors, but received every.object()."
    )
    expect(() => can.access(every.action() as never)).toThrow(
      "[Sixb] can.access accepts application selectors, but received every.action()."
    )
    expect(() => can.view(every.sync() as never)).toThrow(
      "[Sixb] can.view accepts object or dataset selectors, but received every.sync()."
    )
    expect(() => can.run(every.dataset() as never)).toThrow(
      "[Sixb] can.run accepts workflow or sync or pipeline or agent selectors, but received every.dataset()."
    )
  })

  test("a definition from the wrong family is rejected, not filed under its own target", () => {
    // Recognising a `kind` is not accepting it. These used to return `run:dataset` / `view:application`,
    // and since neither is in `GRANT_KINDS`, startup died on `spec.universeKey` with a `TypeError`
    // naming neither the role nor the definition.
    expect(() => can.run(AccountSnapshot as never)).toThrow(
      "[Sixb] can.run accepts workflow or sync or pipeline or agent definitions, but received one targeting dataset."
    )
    expect(() => can.view(applications.atlas as never)).toThrow(
      "[Sixb] can.view accepts object or dataset definitions, but received one targeting application."
    )
    // The guard sits in `targetOfDefinition`, so it covers the two builders that never read `target`
    // back either. These used to reach startup and be reported as an unknown *action* / *application*.
    expect(() => can.apply(AccountSnapshot as never)).toThrow(
      "[Sixb] can.apply accepts action definitions, but received one targeting dataset."
    )
    expect(() => can.access(syncAccounts as never)).toThrow(
      "[Sixb] can.access accepts application definitions, but received one targeting sync."
    )
  })

  test("an explicit list of two targets is rejected, not filed under the first one", () => {
    // Sniffing only `input[0]` filed the pipeline's id under `run:sync`, so startup validation then
    // reported a real pipeline as an unknown *sync*. Every element has to agree on the target.
    expect(() => can.run([syncAccounts, normalizeAccountsPipeline] as never)).toThrow(
      "[Sixb] can.run requires one target per grant, but received both sync and pipeline definitions. Use one grant each."
    )
    expect(() => can.view([Account, AccountSnapshot] as never)).toThrow(
      "[Sixb] can.view requires one target per grant, but received both object and dataset definitions. Use one grant each."
    )
    // A homogeneous list still resolves to the one target it describes.
    expect(can.run([syncAccounts]).target).toBe("sync")
  })

  test("every.application() selects the whole application universe", () => {
    expect(can.access(every.application())).toEqual({
      kind: "grant",
      capability: "access",
      target: "application",
      selection: { all: true, except: [] },
    })
    expect(can.access(every.application().except([applications.atlas])).selection).toEqual({
      all: true,
      except: ["atlas"],
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

  test("runtime registration rejects access grants on unknown applications", () => {
    expect(() =>
      createRuntime({
        groups: [commercial],
        roles: [
          {
            kind: "role",
            id: "unknown.application",
            grantedToGroupIds: [commercial.id],
            grants: [
              {
                kind: "grant",
                capability: "access",
                target: "application",
                selection: { all: false, ids: ["unknown"] },
              },
            ],
          },
        ],
      })
    ).toThrow("access on unknown application 'unknown'")
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

  test("runtime registration rejects write grants on unknown object types", () => {
    const editRole: RoleDefinition = {
      kind: "role",
      id: "contract.editor",
      grantedToGroupIds: ["commercial"],
      grants: [{ kind: "grant", capability: "edit", selection: { all: false, ids: ["missing"] } }],
    }
    const appendRole: RoleDefinition = {
      kind: "role",
      id: "contract.ingestor",
      grantedToGroupIds: ["commercial"],
      grants: [
        { kind: "grant", capability: "append", selection: { all: false, ids: ["missing"] } },
      ],
    }

    expect(() => createRuntime({ groups: [commercial], roles: [editRole] })).toThrow(
      "unknown object type 'missing'"
    )
    expect(() => createRuntime({ groups: [commercial], roles: [appendRole] })).toThrow(
      "unknown object type 'missing'"
    )
  })

  test("an unregistered capability is named in the error, and the list is derived", () => {
    // The list used to be a hand-written `capability !== "access" && …` chain, so a new capability
    // passed validation and then died on `GRANT_KINDS[kind].universeKey` with a `TypeError` that
    // named neither the role nor the grant.
    const role: RoleDefinition = {
      kind: "role",
      id: "bogus",
      grantedToGroupIds: ["commercial"],
      grants: [
        { kind: "grant", capability: "destroy", selection: { all: false, ids: ["account"] } },
      ] as unknown as RoleDefinition["grants"],
    }

    expect(() => createRuntime({ groups: [commercial], roles: [role] })).toThrow(
      "grant capability must be 'access', 'view', 'edit', 'append', 'apply', 'share', 'run', or 'observe'."
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

    expect(sixb.definitions.security.listRoles()).toEqual([role])
    expect(sixb.definitions.security.getRoleById("contract.operator")).toEqual(role)
    expect(sixb.definitions.security.getRoleById("missing")).toBeNull()
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

    expect(sixb.definitions.security.getRoleById("contract.operator")).toEqual({
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
): SixbHost<readonly [typeof Account]> {
  return new SixbHost<readonly [typeof Account]>({
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
