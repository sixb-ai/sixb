import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type ActionDefinition,
  agent,
  type ConnectorDefinition,
  can,
  col,
  createSixb,
  currentUser,
  type DatasetDefinition,
  defineAction,
  defineConnector,
  defineDataset,
  defineGroup,
  defineMarking,
  defineMembershipPolicy,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineRole,
  defineShare,
  defineSync,
  every,
  type GrantDefinition,
  type GroupDefinition,
  type MembershipPolicyDefinition,
  type PipelineDefinition,
  project,
  prop,
  type RoleDefinition,
  ref,
  SecurityValidationError,
  SixbHost,
  type SyncDefinition,
  userRef,
} from "../src"
import { canPerformMembershipOperation, resolveMembershipPolicyScope } from "../src/security"
import type { CompiledConditionalObjectReadScope } from "../src/storage"
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

  test("createSixb discovers groups, membership policies, roles, and markings from security/", async () => {
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
    await writeProjectFile(
      projectRoot,
      "security/markings/financial.ts",
      `import { defineMarking } from "${coreModuleUrl}"

export const financial = defineMarking("financial", { label: "Financial" })
`
    )
    await writeProjectFile(
      projectRoot,
      "ontology/invoice.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"
import { financial } from "../security/markings/financial"

export const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "double", { markings: [financial] }),
  ],
})
`
    )
    await writeProjectFile(
      projectRoot,
      "security/roles/finance-reader.ts",
      `import { can, defineRole } from "${coreModuleUrl}"
import { Invoice } from "../../ontology/invoice"
import { finance } from "../groups/team"
import { financial } from "../markings/financial"

export const financeReader = defineRole("finance.reader", {
  grantedTo: [finance],
  grants: [can.view(Invoice)],
  clearances: [financial],
})
`
    )

    const sixb = await createSixb({ projectRoot, ...createTestRuntimeDeps() })
    const security = sixb.definitions.security

    expect(security.listGroups().map((group) => group.id)).toEqual([
      "commercial",
      "finance",
      "security-admins",
    ])
    expect(security.getMembershipPolicyById("member-administration")).toEqual({
      kind: "membershipPolicy",
      id: "member-administration",
      grantedToGroupIds: ["security-admins"],
      scopeGroupIds: ["commercial", "finance"],
      can: ["invite", "assignGroups", "suspend"],
    })
    expect(security.listMarkings()).toEqual([
      { kind: "marking", id: "financial", label: "Financial" },
    ])
    expect(security.getRoleById("finance.reader")).toEqual({
      kind: "role",
      id: "finance.reader",
      grantedToGroupIds: ["finance"],
      grants: [
        {
          kind: "grant",
          capability: "view",
          target: "object",
          selection: { all: false, ids: ["invoice"] },
        },
      ],
      clearances: ["financial"],
    })
    expect(
      sixb.definitions.ontology
        .getObjectTypeById("invoice")
        ?.properties.find((property) => property.id === "amount")?.markings
    ).toEqual(["financial"])
  })

  test("explicit groups, membership policies, and roles register without filesystem discovery", async () => {
    const securityAdmins: GroupDefinition = { kind: "group", id: "security-admins" }
    const commercial: GroupDefinition = { kind: "group", id: "commercial" }
    const membershipPolicy: MembershipPolicyDefinition = {
      kind: "membershipPolicy",
      id: "member-admin",
      grantedToGroupIds: ["security-admins"],
      scopeGroupIds: ["commercial"],
      can: ["invite", "assignGroups"],
    }
    const role = defineRole("account.viewer", {
      grantedTo: [commercial],
      grants: [can.view(Account)],
    })

    const sixb = await createSixb({
      projectRoot: await createTempProjectRoot(),
      ontologies: [Account],
      groups: [securityAdmins, commercial],
      membershipPolicies: [membershipPolicy],
      roles: [role],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.security.listGroups()).toEqual([securityAdmins, commercial])
    expect(sixb.definitions.security.listMembershipPolicies()).toEqual([membershipPolicy])
    expect(sixb.definitions.security.listRoles()).toEqual([role])
  })

  const memberAdmin: MembershipPolicyDefinition = {
    kind: "membershipPolicy",
    id: "member-admin",
    grantedToGroupIds: ["security-admins"],
    scopeGroupIds: ["commercial"],
    can: ["invite"],
  }
  const securityAdmins: GroupDefinition = { kind: "group", id: "security-admins" }
  const commercial: GroupDefinition = { kind: "group", id: "commercial" }
  const accountViewer = defineRole("account.viewer", {
    grantedTo: [commercial],
    grants: [can.view(Account)],
  })

  test.each([
    ["duplicate group ids", { groups: [securityAdmins, securityAdmins] }, "Duplicate group id"],
    [
      "duplicate membership policy ids",
      { groups: [securityAdmins, commercial], membershipPolicies: [memberAdmin, memberAdmin] },
      "Duplicate membership policy id",
    ],
    [
      "membership policies referencing unknown groups",
      { groups: [securityAdmins], membershipPolicies: [memberAdmin] },
      "unknown group 'commercial'",
    ],
    [
      "membership policies without granted groups",
      { groups: [commercial], membershipPolicies: [{ ...memberAdmin, grantedToGroupIds: [] }] },
      "must grant membership authority",
    ],
    [
      "membership policies without operations",
      {
        groups: [securityAdmins],
        membershipPolicies: [{ ...memberAdmin, scopeGroupIds: [], can: [] }],
      },
      "must declare at least one operation",
    ],
    [
      "duplicate role ids",
      { groups: [commercial], roles: [accountViewer, accountViewer] },
      "Duplicate role id",
    ],
    ["roles referencing unknown groups", { roles: [accountViewer] }, "unknown group 'commercial'"],
  ] as const)("runtime registration rejects %s", (_case, options, message) => {
    expect(() => createRuntime(options)).toThrow(message)
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

  // What each builder records: its capability, its target family (absent where the capability names
  // only one), and an explicit id list or the whole registered universe minus exclusions.
  test.each([
    [
      "can.view dedupes ids within an explicit selection",
      can.view([Account, Account]),
      { capability: "view", target: "object", selection: { all: false, ids: ["account"] } },
    ],
    [
      "can.view selects every object type",
      can.view(every.object()),
      { capability: "view", target: "object", selection: { all: true, except: [] } },
    ],
    [
      "can.view excludes object types from the universe",
      can.view(every.object().except([Account])),
      { capability: "view", target: "object", selection: { all: true, except: ["account"] } },
    ],
    [
      "can.view takes a dataset definition",
      can.view(AccountSnapshot),
      {
        capability: "view",
        target: "dataset",
        selection: { all: false, ids: ["account.snapshot"] },
      },
    ],
    [
      "can.view selects every dataset",
      can.view(every.dataset()),
      { capability: "view", target: "dataset", selection: { all: true, except: [] } },
    ],
    [
      "can.view excludes datasets from the universe",
      can.view(every.dataset().except([AccountSnapshot])),
      {
        capability: "view",
        target: "dataset",
        selection: { all: true, except: ["account.snapshot"] },
      },
    ],
    [
      "can.observe takes project logs",
      can.observe(project.logs),
      { capability: "observe", target: "logs" },
    ],
    [
      "can.observe takes project activity",
      can.observe(project.activity),
      { capability: "observe", target: "activity" },
    ],
    [
      "can.observe takes Agent usage",
      can.observe(agent.usage),
      { capability: "observe", target: "aiUsage" },
    ],
    [
      "can.observe takes Agent conversations",
      can.observe(agent.threads),
      { capability: "observe", target: "agentThreads" },
    ],
    [
      "can.run takes a sync definition",
      can.run(syncAccounts),
      { capability: "run", target: "sync", selection: { all: false, ids: ["sync-accounts"] } },
    ],
    [
      "can.run takes a homogeneous list",
      can.run([syncAccounts]),
      { capability: "run", target: "sync", selection: { all: false, ids: ["sync-accounts"] } },
    ],
    [
      "can.run selects every sync",
      can.run(every.sync()),
      { capability: "run", target: "sync", selection: { all: true, except: [] } },
    ],
    [
      "can.run excludes syncs from the universe",
      can.run(every.sync().except([syncAccounts])),
      { capability: "run", target: "sync", selection: { all: true, except: ["sync-accounts"] } },
    ],
    [
      "can.run takes a pipeline definition",
      can.run(normalizeAccountsPipeline),
      {
        capability: "run",
        target: "pipeline",
        selection: { all: false, ids: ["normalize-accounts"] },
      },
    ],
    [
      "can.run selects every pipeline",
      can.run(every.pipeline()),
      { capability: "run", target: "pipeline", selection: { all: true, except: [] } },
    ],
    [
      "can.run excludes pipelines from the universe",
      can.run(every.pipeline().except([normalizeAccountsPipeline])),
      {
        capability: "run",
        target: "pipeline",
        selection: { all: true, except: ["normalize-accounts"] },
      },
    ],
    [
      "can.view takes the member directory",
      can.view(project.users),
      { capability: "view", target: "users" },
    ],
    ["can.run takes the project Agent", can.run(agent), { capability: "run", target: "agent" }],
    [
      "can.run takes the project's models",
      can.run(project.models),
      { capability: "run", target: "models" },
    ],
    [
      "can.manage takes a connector definition",
      can.manage(sourceConnector),
      { capability: "manage", target: "connector", selection: { all: false, ids: ["source"] } },
    ],
    [
      "can.manage excludes connectors from the universe",
      can.manage(every.connector().except([sourceConnector])),
      { capability: "manage", target: "connector", selection: { all: true, except: ["source"] } },
    ],
    [
      "can.manage takes Agent usage",
      can.manage(agent.usage),
      { capability: "manage", target: "aiUsage" },
    ],
    [
      "can.manage takes the Agent's shared memory",
      can.manage(agent.memory),
      { capability: "manage", target: "agentMemory" },
    ],
    [
      "can.edit takes an object type",
      can.edit(Account),
      { capability: "edit", selection: { all: false, ids: ["account"] } },
    ],
    [
      "can.edit selects every object type",
      can.edit(every.object()),
      { capability: "edit", selection: { all: true, except: [] } },
    ],
    [
      "can.edit excludes object types from the universe",
      can.edit(every.object().except([Account])),
      { capability: "edit", selection: { all: true, except: ["account"] } },
    ],
    [
      "can.append takes an object type",
      can.append(Account),
      { capability: "append", selection: { all: false, ids: ["account"] } },
    ],
    [
      "can.append selects every object type",
      can.append(every.object()),
      { capability: "append", selection: { all: true, except: [] } },
    ],
  ] as const)("%s", (_case, grant, expected) => {
    expect(grant).toEqual({ kind: "grant", ...expected })
  })

  test("can.view names project.users when given another project surface", () => {
    // Removal proof: without the project check in `view`, both read as an object type with no id.
    const view = can.view as (input: unknown) => unknown

    for (const input of [project, project.logs, project.activity]) {
      expect(() => view(input)).toThrow(
        "[Sixb] can.view accepts object types, datasets, shares, or project.users."
      )
    }
  })

  test("AI usage builders reject strings and unrelated references at runtime", () => {
    // Removal proof: accepting the old string target or skipping reference validation fails here.
    const observe = can.observe as (input: unknown) => unknown
    const manage = can.manage as (input: unknown) => unknown
    for (const input of ["aiUsage", agent, { kind: "unknown" }, [agent.usage], null]) {
      expect(() => observe(input)).toThrow(SecurityValidationError)
      expect(() => manage(input)).toThrow(SecurityValidationError)
    }
    expect(Object.isFrozen(agent)).toBe(true)
    expect(Object.isFrozen(agent.usage)).toBe(true)
    expect(Object.isFrozen(agent.threads)).toBe(true)
    expect(Object.isFrozen(agent.memory)).toBe(true)
    expect(() => manage(agent.threads)).toThrow(SecurityValidationError)
  })

  test("can.observe points the old logs string at project.logs", () => {
    // Removal proof: without the `"logs"` branch in `observe`, the string gets the generic message.
    const observe = can.observe as (input: unknown) => unknown

    expect(() => observe("logs")).toThrow(SecurityValidationError)
    expect(() => observe("logs")).toThrow(
      '[Sixb] can.observe("logs") is now can.observe(project.logs), imported from "@sixb/core".'
    )
  })

  test("can.observe rejects anything but a project surface or agent.usage", () => {
    // Removal proof: checking `kind` with `in` instead of `Object.hasOwn` accepts `toString`.
    const observe = can.observe as (input: unknown) => unknown
    const manage = can.manage as (input: unknown) => unknown

    const inputs = [
      project,
      project.users,
      { kind: "project" },
      { kind: "toString" },
      [project.logs],
    ]
    for (const input of inputs) {
      expect(() => observe(input)).toThrow(
        "[Sixb] can.observe accepts project.logs or project.activity or agent.usage or agent.threads."
      )
    }
    expect(() => manage(project.logs)).toThrow(SecurityValidationError)
    expect(Object.isFrozen(project)).toBe(true)
    expect(Object.isFrozen(project.logs)).toBe(true)
    expect(Object.isFrozen(project.activity)).toBe(true)
    expect(Object.isFrozen(project.users)).toBe(true)
  })

  // Typing already blocks these from TypeScript. The runtime check is what protects an untyped
  // caller, or an `as never`, from filing a grant under another target family.
  test.each([
    [
      "can.edit(every.dataset())",
      () => can.edit(every.dataset() as never),
      "[Sixb] can.edit accepts object selectors, but received every.dataset().",
    ],
    [
      "can.append(every.action())",
      () => can.append(every.action() as never),
      "[Sixb] can.append accepts object selectors, but received every.action().",
    ],
    [
      "can.edit(sync)",
      () => can.edit(syncAccounts as never),
      "[Sixb] can.edit accepts object definitions, but received one targeting sync.",
    ],
    [
      "can.append(dataset)",
      () => can.append(AccountSnapshot as never),
      "[Sixb] can.append accepts object definitions, but received one targeting dataset.",
    ],
    // A breadth selector from the wrong family would otherwise grant over every object type.
    [
      "can.apply(every.object())",
      () => can.apply(every.object() as never),
      "[Sixb] can.apply accepts action selectors, but received every.object().",
    ],
    [
      "can.view(every.sync())",
      () => can.view(every.sync() as never),
      "[Sixb] can.view accepts object or dataset selectors, but received every.sync().",
    ],
    [
      "can.run(every.dataset())",
      () => can.run(every.dataset() as never),
      "[Sixb] can.run accepts workflow or sync or pipeline selectors, but received every.dataset().",
    ],
    // Recognising a `kind` is not accepting it. These used to return `run:dataset` / `view:sync`,
    // and since neither is in `GRANT_KINDS`, startup died on a `TypeError` naming neither the role
    // nor the definition. The guard sits in `targetOfDefinition`, so it covers `can.apply` too.
    [
      "can.run(dataset)",
      () => can.run(AccountSnapshot as never),
      "[Sixb] can.run accepts workflow or sync or pipeline definitions, but received one targeting dataset.",
    ],
    [
      "can.view(sync)",
      () => can.view(syncAccounts as never),
      "[Sixb] can.view accepts object or dataset definitions, but received one targeting sync.",
    ],
    [
      "can.apply(dataset)",
      () => can.apply(AccountSnapshot as never),
      "[Sixb] can.apply accepts action definitions, but received one targeting dataset.",
    ],
    // Sniffing only `input[0]` filed the pipeline's id under `run:sync`, so startup then reported a
    // real pipeline as an unknown sync. Every element has to agree on the target.
    [
      "can.run([sync, pipeline])",
      () => can.run([syncAccounts, normalizeAccountsPipeline] as never),
      "[Sixb] can.run requires one target per grant, but received both sync and pipeline definitions. Use one grant each.",
    ],
    [
      "can.view([object, dataset])",
      () => can.view([Account, AccountSnapshot] as never),
      "[Sixb] can.view requires one target per grant, but received both object and dataset definitions. Use one grant each.",
    ],
  ] as const)("%s is rejected, not filed under another target", (_case, build, message) => {
    expect(build).toThrow(message)
  })

  test.each([
    [
      "roles granted to no groups",
      () => defineRole("empty", { grantedTo: [], grants: [can.view(Account)] }),
      "grantedTo must not be empty",
    ],
    [
      "grant items that are not grants",
      () =>
        defineRole("invalid", {
          grantedTo: [commercial],
          grants: [{ kind: "group", id: "commercial" } as unknown as GroupDefinition & never],
        }),
      "must contain only grant definitions from 'can'",
    ],
  ] as const)("defineRole rejects %s", (_case, define, message) => {
    expect(define).toThrow(message)
  })

  test.each([
    ["view", "object", "unknown object type 'missing'"],
    ["view", "dataset", "unknown dataset 'missing'"],
    ["edit", null, "unknown object type 'missing'"],
    ["append", null, "unknown object type 'missing'"],
    ["apply", null, "unknown action 'missing'"],
    ["run", "sync", "unknown sync 'missing'"],
    ["run", "pipeline", "unknown pipeline 'missing'"],
    ["manage", "connector", "unknown connector 'missing'"],
  ] as const)("runtime registration rejects a %s grant on an unknown %s", (capability, target, message) => {
    const role = {
      kind: "role",
      id: "unknown.target",
      grantedToGroupIds: ["commercial"],
      grants: [
        {
          kind: "grant",
          capability,
          ...(target === null ? {} : { target }),
          selection: { all: false, ids: ["missing"] },
        },
      ],
    } as unknown as RoleDefinition

    expect(() =>
      createRuntime({ groups: [commercial], roles: [role], connectors: [sourceConnector] })
    ).toThrow(message)
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
      "grant capability must be 'view', 'edit', 'append', 'apply', 'share', 'run', 'observe', or 'manage'."
    )
  })

  test("runtime registration accepts the member directory grant", () => {
    const role = defineRole("directory.reader", {
      grantedTo: [commercial],
      grants: [can.view(project.users)],
    })

    expect(() => createRuntime({ groups: [commercial], roles: [role] })).not.toThrow()
  })

  // Logs, AI usage, Agent memory, the project Agent, and the member directory are one surface
  // each. Reproduce: drop `observe`, the singleton `manage` targets, or `view:users` from the
  // singleton check in assertGrantDefinition and these grants are accepted.
  test("runtime registration rejects selections on logs, AI usage, memory, Agent, and directory grants", () => {
    for (const grant of [
      {
        kind: "grant",
        capability: "view",
        target: "users",
        selection: { all: true, except: [] },
      },
      {
        kind: "grant",
        capability: "observe",
        target: "logs",
        selection: { all: true, except: [] },
      },
      {
        kind: "grant",
        capability: "observe",
        target: "activity",
        selection: { all: true, except: [] },
      },
      {
        kind: "grant",
        capability: "observe",
        target: "agentThreads",
        selection: { all: true, except: [] },
      },
      {
        kind: "grant",
        capability: "manage",
        target: "aiUsage",
        selection: { all: true, except: [] },
      },
      {
        kind: "grant",
        capability: "manage",
        target: "agentMemory",
        selection: { all: true, except: [] },
      },
      {
        kind: "grant",
        capability: "run",
        target: "agent",
        selection: { all: false, ids: ["missing"] },
      },
    ]) {
      const role = {
        kind: "role",
        id: "surface.reader",
        grantedToGroupIds: [commercial.id],
        grants: [grant],
      } as unknown as RoleDefinition
      expect(() => createRuntime({ groups: [commercial], roles: [role] })).toThrow(
        `${grant.capability} grant on '${grant.target}' must not declare a selection`
      )
    }
  })

  test("runtime registration rejects an Agent grant when no language model is configured", () => {
    const role = defineRole("agent.runner", {
      grantedTo: [commercial],
      grants: [can.run(agent)],
    })

    expect(() => createRuntime({ groups: [commercial], roles: [role] })).toThrow(
      "grants run on the project Agent, but it is unavailable"
    )
  })
})

describe("view grant conditions", () => {
  const financial = defineMarking("financial")
  const staff = defineGroup("staff")
  const filterable = { query: { searchable: true, filterable: true } } as const

  const Note = defineObjectType({
    id: "note",
    name: "Note",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("owner", ref.user(), filterable),
      prop("topic", "string", filterable),
      prop("body", "string"),
    ],
  })

  const Invoice = defineObjectType({
    id: "invoice",
    name: "Invoice",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("status", "string", filterable),
      prop("amount", "double", { ...filterable, markings: [financial] }),
    ],
  })

  // A subtype may add markings to what it inherits, and `can.view(Invoice)` covers it.
  const DisputedInvoice = defineObjectType({
    id: "disputed-invoice",
    name: "Disputed Invoice",
    extends: Invoice,
    properties: [prop("status", "string", { ...filterable, markings: [financial] })],
  })

  function start(grant: GrantDefinition): SixbHost {
    return new SixbHost({
      ontology: [Note, Invoice, DisputedInvoice],
      markings: [financial],
      groups: [staff],
      roles: [defineRole("staff", { grantedTo: [staff], grants: [grant] })],
      ...createTestRuntimeDeps(),
    })
  }

  function conditionOn(objectTypeId: string, condition: unknown): GrantDefinition {
    return {
      kind: "grant",
      capability: "view",
      target: "object",
      selection: { all: false, ids: [objectTypeId] },
      condition,
    } as GrantDefinition
  }

  test("can.view(Type).where(...) records the condition once, frozen", () => {
    const grant = can.view(Invoice).where((invoice) => invoice.p.status.neq("draft"))

    expect(grant).toEqual({
      kind: "grant",
      capability: "view",
      target: "object",
      selection: { all: false, ids: ["invoice"] },
      condition: { propertyId: "status", op: "neq", value: "draft" },
    })
    expect(Object.isFrozen(grant)).toBe(true)
    expect(Object.isFrozen(grant.condition)).toBe(true)
    expect("where" in grant).toBe(false)
  })

  test("a condition returned as an array means AND, and keeps currentUser() and userRef()", () => {
    const grant = can
      .view(Note)
      .where((note) => [note.p.owner.eq(currentUser()), note.p.owner.neq(userRef("usr_bot"))])

    expect(grant.condition).toEqual({
      op: "and",
      items: [
        { propertyId: "owner", op: "eq", value: { type: "currentUser" } },
        { propertyId: "owner", op: "neq", value: { type: "user", id: "usr_bot" } },
      ],
    })
  })

  // Reproduce: attach `where` in `view` whatever its input, and every grant below carries it.
  test("only a grant on one object type takes .where()", () => {
    let shareGrant: object | undefined
    defineShare("account", {
      target: Account,
      grants: ({ target }) => {
        const grant = can.view(target)
        shareGrant = grant
        return [grant]
      },
    })

    for (const grant of [
      can.view([Invoice]),
      can.view(every.object()),
      can.view(AccountSnapshot),
      can.view(project.users),
      shareGrant,
    ]) {
      expect(grant).toBeDefined()
      expect("where" in (grant as object)).toBe(false)
    }
  })

  test.each([
    [
      "a value that is not a function",
      "status",
      '[Sixb] can.view(invoice).where(...) expects a function, such as (object) => object.p.status.eq("open").',
    ],
    [
      "a callback that returns no condition",
      () => [],
      "[Sixb] can.view(invoice).where(...) returned no condition. Return a predicate, or drop .where() to grant every object.",
    ],
  ] as const)("can.view(Type).where(...) rejects %s", (_case, callback, message) => {
    const grant = can.view(Invoice) as unknown as { where(callback: unknown): unknown }

    expect(() => grant.where(callback)).toThrow(message)
  })

  // Reproduce: skip the validation in resolveViewCondition, or check only the granted type for
  // markings, and these reach the "not supported yet" refusal instead.
  test.each([
    [
      "a condition reading an unknown property",
      conditionOn("note", { propertyId: "missing", op: "eq", value: "x" }),
      "[Sixb] Role 'staff': can.view(note).where(...): Property 'missing' does not exist on object type 'note'",
    ],
    [
      "a condition reading a property without query metadata",
      can.view(Note).where((note) => note.p.body.eq("x")),
      "[Sixb] Role 'staff': can.view(note).where(...): Property 'body' on 'note' must set query.searchable: true and query.filterable: true before it can be used in predicates",
    ],
    [
      "a condition comparing currentUser() with a property that holds no user reference",
      conditionOn("note", { propertyId: "topic", op: "eq", value: currentUser() }),
      "[Sixb] Role 'staff': can.view(note).where(...): currentUser() can only be compared with a ref.user() property; 'note.topic' is not one.",
    ],
    // Reproduce: drop the orderedTextComparison check, and this reaches the refusal instead.
    [
      "a condition ordering text",
      can.view(Note).where((note) => note.not(note.p.topic.gte("M"))),
      "[Sixb] Role 'staff': can.view(note).where(...) compares 'note.topic' with gte(). Storage providers order text differently, so a condition cannot order text: compare with eq, neq, in or contains instead.",
    ],
    [
      "a condition reading a marked property",
      can.view(Invoice).where((invoice) => invoice.p.amount.gt(100)),
      "[Sixb] Role 'staff': can.view(invoice).where(...) reads 'invoice.amount', which carries [financial]. A condition can only read unmarked properties.",
    ],
    [
      "a condition reading a property a covered subtype marks",
      can.view(Invoice).where((invoice) => invoice.p.status.neq("draft")),
      "[Sixb] Role 'staff': can.view(invoice).where(...) reads 'disputed-invoice.status', which carries [financial]. A condition can only read unmarked properties.",
    ],
    [
      "a condition on a grant that does not view one object type",
      {
        ...conditionOn("note", { propertyId: "topic", op: "eq", value: "x" }),
        target: "dataset",
        selection: { all: false, ids: [] },
      } as GrantDefinition,
      "[Sixb] Role 'staff' declares a condition on a grant that is not a view grant on one object type. Write can.view(Type).where(...).",
    ],
  ] as const)("startup rejects %s", (_case, grant, message) => {
    const error = catchError(() => start(grant))

    expect(error).toBeInstanceOf(SecurityValidationError)
    expect((error as Error).message).toBe(message)
  })

  function startOn(
    grant: GrantDefinition,
    createConditionalReadScope: (params: { scope: CompiledConditionalObjectReadScope }) => void
  ): SixbHost {
    const deps = createTestRuntimeDeps()
    const objects = new Proxy(deps.storage.objects, {
      get(target, property, receiver) {
        if (property !== "createConditionalReadScope")
          return Reflect.get(target, property, receiver)

        return (params: Parameters<typeof target.createConditionalReadScope>[0]) => {
          createConditionalReadScope(params)
          return target.createConditionalReadScope(params)
        }
      },
    })
    const storage = new Proxy(deps.storage, {
      get: (target, property, receiver) =>
        property === "objects" ? objects : Reflect.get(target, property, receiver),
    })

    return new SixbHost({
      ontology: [Note, Invoice, DisputedInvoice],
      markings: [financial],
      groups: [staff],
      roles: [defineRole("staff", { grantedTo: [staff], grants: [grant] })],
      ...deps,
      storage,
    })
  }

  // Reproduce: drop assertViewConditionsReadable from the SixbHost constructor, and startup fails
  // on the refusal that follows instead of naming what the storage cannot read.
  test("startup fails on a condition the object storage cannot read", () => {
    const grant = can.view(Note).where((note) => note.p.topic.eq("m"))
    const error = catchError(() =>
      startOn(grant, () => {
        throw new Error("Object storage cannot compile this predicate")
      })
    )

    expect(error).toBeInstanceOf(SecurityValidationError)
    expect((error as Error).message).toBe(
      "[Sixb] Role 'staff': can.view(note).where(...) cannot be read by the configured object storage: Object storage cannot compile this predicate"
    )
  })

  test("startup compiles each condition against the storage, with currentUser() bound", () => {
    const scopes: CompiledConditionalObjectReadScope[] = []
    const grant = can.view(Note).where((note) => note.p.owner.eq(currentUser()))

    expect(() => startOn(grant, ({ scope }) => scopes.push(scope))).toThrow("is not supported yet")

    expect(scopes).toHaveLength(1)
    expect(scopes[0]?.conditions).toEqual([
      {
        objectTypeId: "note",
        predicate: {
          propertyId: "owner",
          op: "eq",
          value: { type: "user", id: expect.any(String) },
          scalarKind: "userRef",
        },
      },
    ])
  })

  // Reads do not apply conditions yet, so a valid one is refused rather than granting every note.
  // Reproduce: drop refuseViewConditions from the SixbHost constructor and startup succeeds.
  test("startup refuses a valid condition until reads enforce it", () => {
    const grant = can.view(Note).where((note) => note.p.owner.eq(currentUser()))

    expect(() => start(grant)).toThrow(
      "[Sixb] Role 'staff': can.view(note).where(...) is not supported yet."
    )
  })
})

function catchError(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error("Expected an error.")
}

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
    connectors?: readonly ConnectorDefinition[]
  } = {}
): SixbHost {
  return new SixbHost({
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
