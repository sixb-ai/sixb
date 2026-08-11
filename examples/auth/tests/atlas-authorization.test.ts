import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  canAccessApplication,
  createSixb,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  isAllowed,
  type OntologySource,
  resolveAuthorizationContext,
  type SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { adminAuditDataset, teamNotesDataset } from "../datasets/auth-data"
import { securityAdmins } from "../security/groups/security-admins"
import { teamMembers } from "../security/groups/team-members"
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
  host: SixbHost<readonly OntologySource[]>,
  groupIds: readonly string[],
  userId = "atlas-user"
) {
  return resolveAuthorizationContext({
    principal: { type: "user", id: userId },
    groupIds,
    roles: host.security.listResolvedRoles(),
  })
}

describe("auth example Atlas authorization", () => {
  test("team members only see and do what their roles grant", async () => {
    const host = await createAuthExampleRuntime()
    await seedAuthExampleObjects(createTestSixb(host))

    const roles = host.security.listResolvedRoles()
    const teamMemberContext = atlasContext(host, [teamMembers.id])
    const adminContext = atlasContext(host, [securityAdmins.id])
    const noGroupsContext = atlasContext(host, [])
    const teamMember = createTestSixb(host, { authorization: teamMemberContext })
    const admin = createTestSixb(host, { authorization: adminContext })
    const noGroups = createTestSixb(host, { authorization: noGroupsContext })

    expect(canAccessApplication(teamMemberContext, roles, "app")).toBe(true)
    expect(canAccessApplication(teamMemberContext, roles, "atlas")).toBe(false)
    expect(canAccessApplication(adminContext, roles, "app")).toBe(true)
    expect(canAccessApplication(adminContext, roles, "atlas")).toBe(true)
    expect(canAccessApplication(noGroupsContext, roles, "app")).toBe(false)
    expect(canAccessApplication(noGroupsContext, roles, "atlas")).toBe(false)

    expect(
      (await teamMember.objects.list({})).objects.map((object) => object.objectTypeId)
    ).toEqual(["note"])
    await expect(teamMember.objects.get("admin-note", "admin-note")).rejects.toThrow(
      "not allowed to view object type 'admin-note'"
    )
    await expect(teamMember.objects.get("access-request", "access-request")).rejects.toThrow(
      "not allowed to view object type 'access-request'"
    )

    expect(teamMember.actions.list().map((action) => action.id)).toEqual(["acknowledge-note"])
    expect(teamMember.datasets.list().map((dataset) => dataset.id)).toEqual([teamNotesDataset.id])
    expect(teamMember.datasets.getById(teamNotesDataset.id)?.id).toBe(teamNotesDataset.id)
    expect(teamMember.datasets.getById(adminAuditDataset.id)).toBeNull()
    await expect(
      teamMember.actions.request({
        actionId: "acknowledge-note",
        subject: { kind: "object", objectTypeId: "note", primaryId: "team-note" },
      })
    ).resolves.toMatchObject({ runId: expect.any(String) })
    await expect(
      teamMember.actions.request({
        actionId: "resolve-access-request",
        subject: { kind: "object", objectTypeId: "access-request", primaryId: "access-request" },
      })
    ).rejects.toThrow("not allowed to apply action 'resolve-access-request'")
    await expect(
      teamMember.workflows.requestById({
        workflowId: "run-access-review",
        input: {
          accessRequest: { objectTypeId: "access-request", primaryId: "access-request" },
        },
      })
    ).rejects.toThrow("not allowed to run workflow 'run-access-review'")
    // Event visibility is derived from grants: team members see events for the
    // objects they can view (Note), but not for AdminNote or AccessRequest.
    const teamMemberObjectEvents = (await teamMember.events.read())
      .filter((event) => event.type === "object.created" || event.type === "object.updated")
      .map((event) => event.payload.objectTypeId)
    expect(new Set(teamMemberObjectEvents)).toEqual(new Set(["note"]))

    expect(
      new Set((await admin.objects.list({})).objects.map((object) => object.objectTypeId))
    ).toEqual(new Set(["note", "admin-note", "access-request"]))
    expect(
      admin.actions
        .list()
        .map((action) => action.id)
        .sort()
    ).toEqual(["acknowledge-note", "resolve-access-request"])
    expect(new Set(admin.datasets.list().map((dataset) => dataset.id))).toEqual(
      new Set([teamNotesDataset.id, adminAuditDataset.id])
    )
    await expect(
      admin.actions.request({
        actionId: "resolve-access-request",
        subject: { kind: "object", objectTypeId: "access-request", primaryId: "access-request" },
      })
    ).resolves.toMatchObject({ runId: expect.any(String) })
    await expect(
      admin.workflows.requestById({
        workflowId: "run-access-review",
        input: {
          accessRequest: { objectTypeId: "access-request", primaryId: "access-request" },
        },
      })
    ).resolves.toMatchObject({ runId: expect.any(String) })
    expect((await admin.events.read()).map((event) => event.type)).toContain("object.created")
    expect(isAllowed(atlasContext(host, [securityAdmins.id]), { kind: "logs.observe" })).toBe(true)
    expect(isAllowed(atlasContext(host, [teamMembers.id]), { kind: "logs.observe" })).toBe(false)

    expect(await noGroups.objects.list({})).toEqual({ objects: [], hasMore: false, total: 0 })
    expect(noGroups.actions.list()).toEqual([])
    expect(noGroups.datasets.list()).toEqual([])
  })

  test("security admins can administer members while team members cannot", async () => {
    const sixb = await createAuthExampleRuntime()
    const admin = sixb.auth.getMembershipCapabilities({ callerGroups: [securityAdmins] })
    const teamMember = sixb.auth.getMembershipCapabilities({ callerGroups: [teamMembers] })

    // The scope of `member-administration` is both example groups, so an admin reaches either one.
    expect([...admin.assignableGroupIds].sort()).toEqual([securityAdmins.id, teamMembers.id])

    for (const operation of ["invite", "assignGroups", "suspend"] as const) {
      expect(admin.holds[operation]).toBe(true)
      expect(admin.covers(operation, [])).toBe(true)
      expect(admin.covers(operation, [teamMembers])).toBe(true)
      expect(admin.covers(operation, [securityAdmins])).toBe(true)

      expect(teamMember.holds[operation]).toBe(false)
      expect(teamMember.covers(operation, [teamMembers])).toBe(false)
    }
  })
})
