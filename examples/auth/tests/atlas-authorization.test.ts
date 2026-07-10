import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  canAccessApplication,
  canPerformMembershipOperation,
  createSixb,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  isAllowed,
  type OntologySource,
  resolveAuthorizationContext,
  resolveMembershipPolicyScope,
  type Sixb,
} from "@sixb/core"
import { adminAuditDataset, teamNotesDataset } from "../datasets/auth-data"
import { seedAuthExampleObjects } from "../seed"

async function createAuthExampleRuntime() {
  return createSixb({
    id: "auth-example-test",
    projectRoot: resolve(import.meta.dir, ".."),
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}

function atlasContext(
  sixb: Sixb<readonly OntologySource[]>,
  groupIds: readonly string[],
  userId = "atlas-user"
) {
  return resolveAuthorizationContext({
    principal: { type: "user", id: userId },
    groupIds,
    roles: sixb.security.getResolvedRoles(),
  })
}

describe("auth example Atlas authorization", () => {
  test("team members only see and do what their roles grant", async () => {
    const sixb = await createAuthExampleRuntime()
    await seedAuthExampleObjects(sixb)

    const roles = sixb.security.getResolvedRoles()
    const teamMemberContext = atlasContext(sixb, ["team-members"])
    const adminContext = atlasContext(sixb, ["security-admins"])
    const noGroupsContext = atlasContext(sixb, [])
    const teamMember = sixb.as(teamMemberContext)
    const admin = sixb.as(adminContext)
    const noGroups = sixb.as(noGroupsContext)

    expect(canAccessApplication(teamMemberContext, roles, "app")).toBe(true)
    expect(canAccessApplication(teamMemberContext, roles, "atlas")).toBe(false)
    expect(canAccessApplication(adminContext, roles, "app")).toBe(true)
    expect(canAccessApplication(adminContext, roles, "atlas")).toBe(true)
    expect(canAccessApplication(noGroupsContext, roles, "app")).toBe(false)
    expect(canAccessApplication(noGroupsContext, roles, "atlas")).toBe(false)

    expect((await teamMember.list({})).objects.map((object) => object.objectTypeId)).toEqual([
      "note",
    ])
    await expect(teamMember.getObject("admin-note", "admin-note")).rejects.toThrow(
      "not allowed to view object type 'admin-note'"
    )
    await expect(teamMember.getObject("access-request", "access-request")).rejects.toThrow(
      "not allowed to view object type 'access-request'"
    )

    expect(teamMember.listActions().map((action) => action.id)).toEqual(["acknowledge-note"])
    expect(teamMember.listDatasets().map((dataset) => dataset.id)).toEqual([teamNotesDataset.id])
    expect(teamMember.getDatasetById(teamNotesDataset.id)?.id).toBe(teamNotesDataset.id)
    expect(teamMember.getDatasetById(adminAuditDataset.id)).toBeNull()
    await expect(
      teamMember.requestAction({
        actionId: "acknowledge-note",
        subject: { kind: "object", objectTypeId: "note", primaryId: "team-note" },
      })
    ).resolves.toMatchObject({ runId: expect.any(String) })
    await expect(
      teamMember.requestAction({
        actionId: "resolve-access-request",
        subject: { kind: "object", objectTypeId: "access-request", primaryId: "access-request" },
      })
    ).rejects.toThrow("not allowed to apply action 'resolve-access-request'")
    await expect(
      teamMember.runWorkflow({
        workflowId: "run-access-review",
        input: {
          accessRequest: { objectTypeId: "access-request", primaryId: "access-request" },
        },
      })
    ).rejects.toThrow("not allowed to run workflow 'run-access-review'")
    // Event visibility is derived from grants: team members see events for the
    // objects they can view (Note), but not for AdminNote or AccessRequest.
    const teamMemberObjectEvents = (await teamMember.readEvents())
      .filter((event) => event.type === "object.upserted")
      .map((event) => event.payload.objectTypeId)
    expect(new Set(teamMemberObjectEvents)).toEqual(new Set(["note"]))

    expect(new Set((await admin.list({})).objects.map((object) => object.objectTypeId))).toEqual(
      new Set(["note", "admin-note", "access-request"])
    )
    expect(
      admin
        .listActions()
        .map((action) => action.id)
        .sort()
    ).toEqual(["acknowledge-note", "resolve-access-request"])
    expect(new Set(admin.listDatasets().map((dataset) => dataset.id))).toEqual(
      new Set([teamNotesDataset.id, adminAuditDataset.id])
    )
    await expect(
      admin.requestAction({
        actionId: "resolve-access-request",
        subject: { kind: "object", objectTypeId: "access-request", primaryId: "access-request" },
      })
    ).resolves.toMatchObject({ runId: expect.any(String) })
    await expect(
      admin.runWorkflow({
        workflowId: "run-access-review",
        input: {
          accessRequest: { objectTypeId: "access-request", primaryId: "access-request" },
        },
      })
    ).resolves.toMatchObject({ runId: expect.any(String) })
    expect((await admin.readEvents()).map((event) => event.type)).toContain("object.upserted")
    expect(isAllowed(atlasContext(sixb, ["security-admins"]), { kind: "logs.observe" })).toBe(true)
    expect(isAllowed(atlasContext(sixb, ["team-members"]), { kind: "logs.observe" })).toBe(false)

    expect(await noGroups.list({})).toEqual({ objects: [], hasMore: false, total: 0 })
    expect(noGroups.listActions()).toEqual([])
    expect(noGroups.listDatasets()).toEqual([])
  })

  test("security admins can administer members while team members cannot", async () => {
    const sixb = await createAuthExampleRuntime()
    const membershipPolicies = sixb.security.getMembershipPolicyDefinitions()
    const adminScope = resolveMembershipPolicyScope({
      membershipPolicies,
      callerGroupIds: ["security-admins"],
    })
    const teamMemberScope = resolveMembershipPolicyScope({
      membershipPolicies,
      callerGroupIds: ["team-members"],
    })

    for (const operation of ["invite", "assignGroups", "suspend"] as const) {
      expect(canPerformMembershipOperation(adminScope, operation, [])).toBe(true)
      expect(canPerformMembershipOperation(adminScope, operation, ["team-members"])).toBe(true)
      expect(canPerformMembershipOperation(adminScope, operation, ["security-admins"])).toBe(true)
      expect(canPerformMembershipOperation(teamMemberScope, operation, ["team-members"])).toBe(
        false
      )
    }
  })
})
