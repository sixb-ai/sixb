import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  canInviteGroupIds,
  createSixb,
  defineGroup,
  defineInvitePolicy,
  defineObjectType,
  type GroupDefinition,
  type InvitePolicyDefinition,
  prop,
  resolveInvitePolicyScope,
  SecurityValidationError,
  Sixb,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const coreModuleUrl = pathToFileURL(resolve(import.meta.dir, "..", "src", "index.ts")).href
const tempRoots = new Set<string>()

const Account = defineObjectType({
  id: "account",
  name: "Account",
  properties: [prop("id", "string", { required: true, primary: true })],
})

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

  test("defineInvitePolicy normalizes group definitions to ids", () => {
    const securityAdmins = defineGroup("security-admins")
    const commercial = defineGroup("commercial")
    const finance = defineGroup("finance")

    expect(
      defineInvitePolicy("default-invites", {
        grantedTo: [securityAdmins],
        canInviteTo: [commercial, finance],
        canInviteWithoutGroups: true,
      })
    ).toEqual({
      kind: "invitePolicy",
      id: "default-invites",
      grantedToGroupIds: ["security-admins"],
      canInviteToGroupIds: ["commercial", "finance"],
      canInviteWithoutGroups: true,
    })
  })

  test("defineInvitePolicy rejects policies that grant nothing", () => {
    const securityAdmins = defineGroup("security-admins")

    expect(() =>
      defineInvitePolicy("empty", {
        grantedTo: [securityAdmins],
      })
    ).toThrow(SecurityValidationError)
  })

  test("invite policy scopes combine applicable policies", () => {
    const scope = resolveInvitePolicyScope({
      callerGroupIds: ["security-admins"],
      invitePolicies: [
        {
          kind: "invitePolicy",
          id: "commercial-invites",
          grantedToGroupIds: ["security-admins"],
          canInviteToGroupIds: ["commercial"],
        },
        {
          kind: "invitePolicy",
          id: "finance-invites",
          grantedToGroupIds: ["security-admins"],
          canInviteToGroupIds: ["finance"],
          canInviteWithoutGroups: true,
        },
        {
          kind: "invitePolicy",
          id: "ignored",
          grantedToGroupIds: ["other-admins"],
          canInviteToGroupIds: ["engineering"],
        },
      ],
    })

    expect(scope.policyIds).toEqual(["commercial-invites", "finance-invites"])
    expect([...scope.canInviteToGroupIds]).toEqual(["commercial", "finance"])
    expect(scope.canInviteWithoutGroups).toBe(true)
    expect(canInviteGroupIds(scope, ["commercial", "finance"])).toBe(true)
    expect(canInviteGroupIds(scope, [])).toBe(true)
    expect(canInviteGroupIds(scope, ["engineering"])).toBe(false)
  })

  test("createSixb discovers groups and invite policies from security folders", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "security/groups/team.ts",
      `import { defineGroup } from "${coreModuleUrl}"

export const securityAdmins = defineGroup("security-admins")
export const commercial = defineGroup("commercial")
export const extraGroups = [defineGroup("finance")]
`
    )

    await writeProjectFile(
      projectRoot,
      "security/invite-policies/default.ts",
      `import { defineInvitePolicy } from "${coreModuleUrl}"
import { commercial, extraGroups, securityAdmins } from "../groups/team"

export const defaultInvites = defineInvitePolicy("default-invites", {
  grantedTo: [securityAdmins],
  canInviteTo: [commercial, extraGroups[0]],
  canInviteWithoutGroups: true,
})
`
    )

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Account],
      ...createTestRuntimeDeps(),
    })

    expect(new Set(sixb.security.getGroupDefinitions().map((group) => group.id))).toEqual(
      new Set(["security-admins", "commercial", "finance"])
    )
    expect(sixb.security.getGroupById("commercial")?.id).toBe("commercial")
    expect(sixb.security.getGroupById("missing")).toBeNull()
    expect(sixb.security.getInvitePolicyById("default-invites")).toEqual({
      kind: "invitePolicy",
      id: "default-invites",
      grantedToGroupIds: ["security-admins"],
      canInviteToGroupIds: ["commercial", "finance"],
      canInviteWithoutGroups: true,
    })
  })

  test("explicit groups and invite policies register without filesystem discovery", async () => {
    const securityAdmins: GroupDefinition = { kind: "group", id: "security-admins" }
    const commercial: GroupDefinition = { kind: "group", id: "commercial" }
    const invitePolicy: InvitePolicyDefinition = {
      kind: "invitePolicy",
      id: "default-invites",
      grantedToGroupIds: ["security-admins"],
      canInviteToGroupIds: ["commercial"],
    }

    const sixb = await createSixb({
      projectRoot: await createTempProjectRoot(),
      ontologies: [Account],
      groups: [securityAdmins, commercial],
      invitePolicies: [invitePolicy],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.security.getGroupDefinitions()).toEqual([securityAdmins, commercial])
    expect(sixb.security.getInvitePolicyDefinitions()).toEqual([invitePolicy])
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

  test("runtime registration rejects duplicate invite policy ids", () => {
    const groups: GroupDefinition[] = [
      { kind: "group", id: "security-admins" },
      { kind: "group", id: "commercial" },
    ]

    const policy: InvitePolicyDefinition = {
      kind: "invitePolicy",
      id: "default-invites",
      grantedToGroupIds: ["security-admins"],
      canInviteToGroupIds: ["commercial"],
    }

    expect(() =>
      createRuntime({
        groups,
        invitePolicies: [policy, policy],
      })
    ).toThrow(SecurityValidationError)
  })

  test("runtime registration rejects invite policies referencing unknown groups", () => {
    expect(() =>
      createRuntime({
        groups: [{ kind: "group", id: "security-admins" }],
        invitePolicies: [
          {
            kind: "invitePolicy",
            id: "default-invites",
            grantedToGroupIds: ["security-admins"],
            canInviteToGroupIds: ["commercial"],
          },
        ],
      })
    ).toThrow("unknown group 'commercial'")
  })

  test("runtime registration rejects invite policies without granted groups", () => {
    expect(() =>
      createRuntime({
        groups: [{ kind: "group", id: "commercial" }],
        invitePolicies: [
          {
            kind: "invitePolicy",
            id: "default-invites",
            grantedToGroupIds: [],
            canInviteToGroupIds: ["commercial"],
          },
        ],
      })
    ).toThrow("must grant invitation authority")
  })

  test("empty security definitions remain allowed at the definition layer", () => {
    const sixb = createRuntime()

    expect(sixb.security.getGroupDefinitions()).toEqual([])
    expect(sixb.security.getInvitePolicyDefinitions()).toEqual([])
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
    invitePolicies?: readonly InvitePolicyDefinition[]
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
