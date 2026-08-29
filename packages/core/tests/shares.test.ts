import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  AuthorizationError,
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShare,
  ObjectNotFoundError,
  objectRef,
  prop,
  resolveAuthorizationContext,
  ShareError,
  type SixbDefinitions,
  SixbHost,
} from "../src"
import { createTestSixb, type TestExecutionHost } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Report = defineObjectType({
  id: "report",
  name: "Report",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Other = defineObjectType({
  id: "other",
  name: "Other",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const acknowledge = defineAction("acknowledge-report")
  .on(Report)
  .params({})
  .edits(() => {})

const PublishedReport = defineShare("published-report", {
  target: Report,
  grants: ({ target }) => [can.view(target), can.apply(acknowledge).on(target)],
})

const publishers = defineGroup("publishers")
const viewers = defineGroup("viewers")
const shareOnly = defineGroup("share-only")

const publisher = defineRole("report.publisher", {
  grantedTo: [publishers],
  grants: [can.view(Report), can.share(PublishedReport)],
})
const viewer = defineRole("report.viewer", {
  grantedTo: [viewers],
  grants: [can.view(Report)],
})
const shareManagerWithoutView = defineRole("report.share-only", {
  grantedTo: [shareOnly],
  grants: [can.share(PublishedReport)],
})

function createHost() {
  return new SixbHost({
    id: "project-1",
    ontology: [Report, Other],
    actions: [acknowledge],
    shares: [PublishedReport],
    groups: [publishers, viewers, shareOnly],
    roles: [publisher, viewer, shareManagerWithoutView],
    ...createTestRuntimeDeps(),
  })
}

function principalSixb(
  host: TestExecutionHost & { readonly definitions: SixbDefinitions },
  groupIds: readonly string[],
  principal: { readonly type: "user" | "serviceAccount"; readonly id: string } = {
    type: "user",
    id: "usr_publisher",
  }
) {
  return createTestSixb(host, {
    authorization: resolveAuthorizationContext({
      principal,
      groupIds,
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })
}

describe("Share lifecycle", () => {
  test("issues a one-time secret, lists a bounded page, and preserves first revocation", async () => {
    const host = createHost()
    await createTestSixb(host).objects.upsert(Report.id, { id: "report-1" })
    const sixb = principalSixb(host, [publishers.id])

    const invitation = await sixb.shares.issue(PublishedReport, {
      target: objectRef(Report, "report-1"),
      destinationPath: "/reports/report-1",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    })

    expect(invitation.secret).toHaveLength(43)
    expect(invitation.grant).toMatchObject({
      definitionId: PublishedReport.id,
      target: { objectTypeId: Report.id, primaryId: "report-1" },
      issuedBy: { type: "user", id: "usr_publisher" },
      destinationPath: "/reports/report-1",
    })
    expect(JSON.stringify(invitation.grant)).not.toContain(invitation.secret)
    expect(invitation.grant).not.toHaveProperty("tokenHash")
    expect(invitation.grant).not.toHaveProperty("authoritySnapshot")

    const stored = await host.storage.shareGrants?.getById({
      projectId: host.id,
      id: invitation.grant.id,
    })
    expect(stored?.tokenHash).toBe(createHash("sha256").update(invitation.secret).digest("hex"))
    expect(stored?.authoritySnapshot).toMatchObject({
      version: 1,
      access: {
        grants: [
          {
            kind: "object.view",
            selection: {
              roots: [{ anchor: { objectTypeId: Report.id, primaryId: "report-1" } }],
            },
          },
          {
            kind: "action.apply",
            actionId: acknowledge.id,
            subjects: [{ objectTypeId: Report.id, primaryId: "report-1" }],
          },
        ],
      },
    })

    await expect(
      sixb.shares.list(PublishedReport, {
        target: objectRef(Report, "report-1"),
        limit: 1,
      })
    ).resolves.toMatchObject({
      grants: [{ id: invitation.grant.id }],
      total: 1,
      hasMore: false,
    })

    const unauthorized = principalSixb(host, [viewers.id])
    await expect(unauthorized.shares.revoke(invitation.grant.id)).resolves.toBeNull()
    await expect(unauthorized.shares.revoke("missing")).resolves.toBeNull()

    const otherManager = principalSixb(host, [publishers.id], {
      type: "user",
      id: "usr_other_manager",
    })
    const revoked = await otherManager.shares.revoke(invitation.grant.id)
    await expect(otherManager.shares.revoke(invitation.grant.id)).resolves.toEqual(revoked)
    expect(revoked?.revokedBy).toEqual({ type: "user", id: "usr_other_manager" })
    await expect(sixb.shares.list(PublishedReport)).resolves.toMatchObject({
      grants: [],
      total: 0,
    })
  })

  test("uses the canonical registered definition for issueById", async () => {
    const host = createHost()
    await createTestSixb(host).objects.upsert(Report.id, { id: "report-1" })
    const sixb = principalSixb(host, [publishers.id], {
      type: "serviceAccount",
      id: "svc_publisher",
    })
    const invitation = await sixb.shares.issueById({
      definitionId: PublishedReport.id,
      target: objectRef(Report, "report-1"),
      destinationPath: "/reports/report-1",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    })
    expect(invitation.grant.issuedBy).toEqual({
      type: "serviceAccount",
      id: "svc_publisher",
    })
    await expect(sixb.shares.listById({ definitionId: PublishedReport.id })).resolves.toMatchObject(
      { grants: [{ id: invitation.grant.id }], total: 1 }
    )
    await expect(
      sixb.shares.listById({ definitionId: PublishedReport.id, primaryId: "report-1" })
    ).resolves.toMatchObject({ grants: [{ id: invitation.grant.id }], total: 1 })
  })

  test("requires can.share, principal authority, and canonical access to the exact target", async () => {
    const host = createHost()
    await createTestSixb(host).objects.upsert(Report.id, { id: "report-1" })
    const input = {
      target: objectRef(Report, "report-1"),
      destinationPath: "/reports/report-1",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }

    const noShare = principalSixb(host, [viewers.id])
    expect(noShare.shares.listDefinitions()).toEqual([])
    expect(noShare.shares.getDefinitionById(PublishedReport.id)).toBeNull()
    await expect(noShare.shares.issue(PublishedReport, input)).rejects.toBeInstanceOf(
      AuthorizationError
    )
    await expect(
      noShare.shares.issueById({ definitionId: "missing", ...input })
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(
      noShare.shares.listById({ definitionId: PublishedReport.id })
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(noShare.shares.listById({ definitionId: "missing" })).rejects.toBeInstanceOf(
      AuthorizationError
    )

    const noView = principalSixb(host, [shareOnly.id])
    await expect(noView.shares.issue(PublishedReport, input)).rejects.toBeInstanceOf(
      AuthorizationError
    )

    const unrestricted = createTestSixb(host)
    await expect(unrestricted.shares.issue(PublishedReport, input)).rejects.toBeInstanceOf(
      ShareError
    )
    expect(unrestricted.shares.listDefinitions()).toEqual([])
  })

  test("validates target existence, exact type, expiry, destination, and definition id", async () => {
    const host = createHost()
    await createTestSixb(host).objects.upsert(Report.id, { id: "report-1" })
    const sixb = principalSixb(host, [publishers.id])
    const valid = {
      target: objectRef(Report, "report-1"),
      destinationPath: "/reports/report-1",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }

    await expect(
      sixb.shares.issue(PublishedReport, {
        ...valid,
        target: objectRef(Report, "missing"),
      })
    ).rejects.toBeInstanceOf(ObjectNotFoundError)
    await expect(
      sixb.shares.issue(PublishedReport, {
        ...valid,
        target: objectRef(Other, "other-1") as never,
      })
    ).rejects.toMatchObject({ reason: "invalid_input" })
    await expect(
      sixb.shares.issue(PublishedReport, { ...valid, expiresAt: new Date(0) })
    ).rejects.toMatchObject({ reason: "invalid_input" })
    await expect(
      sixb.shares.issue(PublishedReport, {
        ...valid,
        destinationPath: "https://example.com/report-1",
      })
    ).rejects.toMatchObject({ reason: "invalid_input" })
    await expect(
      sixb.shares.issue(PublishedReport, {
        ...valid,
        destinationPath: "/shared/report-1",
      })
    ).rejects.toMatchObject({ reason: "invalid_input" })
    await expect(
      sixb.shares.issue(PublishedReport, {
        ...valid,
        destinationPath: "/%73hared/report-1",
      })
    ).rejects.toMatchObject({ reason: "invalid_input" })
    await expect(
      sixb.shares.issueById({ ...valid, definitionId: "missing" })
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(
      sixb.shares.issue(null as unknown as typeof PublishedReport, valid)
    ).rejects.toMatchObject({ reason: "invalid_input" })
    await expect(sixb.shares.listById(null as never)).rejects.toMatchObject({
      reason: "invalid_input",
    })

    const targetWithUnrelatedGetter = {
      objectTypeId: Report.id,
      primaryId: "report-1",
    } as Record<string, unknown>
    Object.defineProperty(targetWithUnrelatedGetter, "unrelated", {
      enumerable: true,
      get: () => {
        throw new Error("unrelated target getter must not run")
      },
    })
    await expect(
      sixb.shares.issue(PublishedReport, {
        ...valid,
        target: targetWithUnrelatedGetter as never,
      })
    ).resolves.toHaveProperty("grant.target", {
      objectTypeId: Report.id,
      primaryId: "report-1",
    })
  })
})
