import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  AuthorizationError,
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShareType,
  every,
  type OntologySource,
  objectRef,
  param,
  prop,
  ref,
  resolveAuthorizationContext,
  ShareError,
  SixbHost,
} from "../src"
import type { ResolvedRole } from "../src/authorization"
import { createTestSixb } from "../src/testing"
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

const PublishedReportShare = defineShareType({
  id: "published-report",
  target: Report,
  grants: [can.view(Report), can.apply(acknowledge)],
})

const publishers = defineGroup("publishers")
const publisher = defineRole("report.publisher", {
  grantedTo: [publishers],
  grants: [can.view(Report), can.share(PublishedReportShare)],
})

function createHost() {
  return new SixbHost({
    id: "project-1",
    ontology: [Report, Other],
    actions: [acknowledge],
    shares: [PublishedReportShare],
    groups: [publishers],
    roles: [publisher],
    ...createTestRuntimeDeps(),
  })
}

function publisherContext(roles: readonly ResolvedRole[], principalId = "usr_publisher") {
  return resolveAuthorizationContext({
    principal: { type: "user", id: principalId },
    groupIds: [publishers.id],
    roles,
  })
}

describe("shared access grants", () => {
  test.each([
    "sales/report",
    ":report",
    ".report",
    "report name",
  ])("rejects route-unsafe ShareType id %s", (id) => {
    expect(() =>
      defineShareType({
        id,
        target: Report,
        grants: [can.view(Report)],
      })
    ).toThrow("route-safe")
  })

  test("issues once, lists by exact target, and preserves the first revocation", async () => {
    const host = createHost()
    const setup = createTestSixb(host)
    await setup.objects.upsert(Report.id, { id: "report-1" })

    const sixb = createTestSixb(host, {
      authorization: publisherContext(host.definitions.security.listResolvedRoles()),
    })
    const invitation = await sixb.shares.issue({
      type: PublishedReportShare,
      target: objectRef(Report, "report-1"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    })

    expect(invitation.secret).toHaveLength(43)
    expect(invitation.grant).toMatchObject({
      shareTypeId: PublishedReportShare.id,
      target: { objectTypeId: Report.id, primaryId: "report-1" },
      issuedBy: { type: "user", id: "usr_publisher" },
      grants: [
        { capability: "view", objectTypeId: Report.id },
        { capability: "apply", actionId: acknowledge.id },
      ],
    })
    expect(JSON.stringify(invitation.grant)).not.toContain(invitation.secret)

    const stored = await host.storage.shareGrants?.get({
      projectId: host.id,
      grantId: invitation.grant.id,
    })
    expect(stored?.tokenDigest).toBe(
      createHash("sha256").update(invitation.secret).digest("base64url")
    )
    expect(stored?.tokenDigest).not.toBe(invitation.secret)

    await expect(
      sixb.shares.list({
        type: PublishedReportShare,
        target: objectRef(Report, "report-1"),
      })
    ).resolves.toHaveLength(1)

    const otherManager = createTestSixb(host, {
      authorization: publisherContext(
        host.definitions.security.listResolvedRoles(),
        "usr_other_manager"
      ),
    })
    const revoked = await otherManager.shares.revoke(invitation.grant.id)
    await expect(otherManager.shares.revoke(invitation.grant.id)).resolves.toEqual(revoked)
    expect(revoked?.revokedBy).toEqual({ type: "user", id: "usr_other_manager" })
    await expect(
      sixb.shares.list({
        type: PublishedReportShare,
        target: objectRef(Report, "report-1"),
      })
    ).resolves.toEqual([])
  })

  test("requires can.share and canonical access to the exact target", async () => {
    const host = createHost()
    const setup = createTestSixb(host)
    await setup.objects.upsert(Report.id, { id: "report-1" })

    const noShare = resolveAuthorizationContext({
      principal: { type: "user", id: "usr_viewer" },
      groupIds: [publishers.id],
      roles: host.definitions.security.listResolvedRoles().map((role) => ({
        ...role,
        grants: { ...role.grants, "share:share": new Set<string>() },
      })),
    })
    const ungranted = createTestSixb(host, { authorization: noShare })
    expect(ungranted.shares.listTypes()).toEqual([])
    expect(ungranted.shares.getTypeById(PublishedReportShare.id)).toBeNull()
    await expect(
      ungranted.shares.issue({
        type: PublishedReportShare,
        target: objectRef(Report, "report-1"),
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(AuthorizationError)

    const noView = resolveAuthorizationContext({
      principal: { type: "user", id: "usr_share_only" },
      groupIds: [publishers.id],
      roles: host.definitions.security.listResolvedRoles().map((role) => ({
        ...role,
        grants: { ...role.grants, "view:object": new Set<string>() },
      })),
    })
    await expect(
      createTestSixb(host, { authorization: noView }).shares.issue({
        type: PublishedReportShare,
        target: objectRef(Report, "report-1"),
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(AuthorizationError)

    await expect(
      setup.shares.issue({
        type: PublishedReportShare,
        target: objectRef(Report, "report-1"),
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(ShareError)
    expect(setup.shares.listTypes()).toEqual([])
  })

  test("rejects broad share-type grants at startup", () => {
    const broad = defineShareType({
      id: "broad",
      target: Report,
      grants: [can.view(every.object())],
    })

    expect(
      () =>
        new SixbHost<readonly OntologySource[]>({
          id: "project-1",
          ontology: [Report, Other],
          shares: [broad],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("cannot use broad grants")
  })

  test("rejects unsupported share-type authority at startup", () => {
    const globalAction = defineAction("global-action")
      .params({})
      .writeback(async () => {})
    const otherAction = defineAction("other-action")
      .on(Other)
      .params({})
      .writeback(async () => {})
    const objectRefAction = defineAction("object-ref-action")
      .on(Report)
      .params({ related: param(ref(Other)) })
      .writeback(async () => {})

    const cases = [
      {
        share: defineShareType({
          id: "global-action-share",
          target: Report,
          grants: [can.view(Report), can.apply(globalAction)],
        }),
        actions: [globalAction],
        expected: "unknown or global action",
      },
      {
        share: defineShareType({
          id: "wrong-target-share",
          target: Report,
          grants: [can.view(Report), can.apply(otherAction)],
        }),
        actions: [otherAction],
        expected: "does not apply to 'report'",
      },
      {
        share: defineShareType({
          id: "object-ref-share",
          target: Report,
          grants: [can.view(Report), can.apply(objectRefAction)],
        }),
        actions: [objectRefAction],
        expected: "cannot expose objectRef parameters",
      },
      {
        share: defineShareType({
          id: "missing-view-share",
          target: Report,
          grants: [can.apply(acknowledge)],
        }),
        actions: [acknowledge],
        expected: "must include can.view(report)",
      },
    ]

    for (const { share, actions, expected } of cases) {
      expect(
        () =>
          new SixbHost<readonly OntologySource[]>({
            id: "project-1",
            ontology: [Report, Other],
            actions,
            shares: [share],
            ...createTestRuntimeDeps(),
          })
      ).toThrow(expected)
    }
  })
})
