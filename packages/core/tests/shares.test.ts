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
  link,
  ObjectNotFoundError,
  objectRef,
  param,
  prop,
  resolveAuthorizationContext,
  ShareError,
  type SixbDefinitions,
  SixbHost,
} from "../src"
import { drainActionRuns } from "../src/actions"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import {
  createTestAutomaticWorkflowExecution,
  createTestSixb,
  type TestExecutionHost,
} from "../src/testing"
import { createSharedTestScope } from "./shared-test-scope"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Other = defineObjectType({
  id: "other",
  name: "Other",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Report = defineObjectType({
  id: "report",
  name: "Report",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("sources", Other)],
})

const acknowledge = defineAction("acknowledge-report")
  .on(Report)
  .params({})
  .edits(() => {})

// Closing a report retires the link it was shared through, from its effects.
const closeReport = defineAction("close-report")
  .on(Report)
  .params({ grantId: param("string") })
  .edits(() => {})
  .effects(async ({ params, sixb }) => {
    revocations.push(await sixb.shares.revoke(params.grantId))
  })
const revocations: unknown[] = []

const PublishedReport = defineShare("published-report", {
  target: Report,
  grants: ({ target }) => [can.view(target), can.apply(acknowledge).on(target)],
})

const SourcedReport = defineShare("sourced-report", {
  target: Report,
  grants: ({ target }) => [can.view(target).withLinks([Report.l.sources])],
})

const publishers = defineGroup("publishers")
const viewers = defineGroup("viewers")
const shareOnly = defineGroup("share-only")
const sourceViewers = defineGroup("source-viewers")

const publisher = defineRole("report.publisher", {
  grantedTo: [publishers],
  grants: [
    can.view(Report),
    can.share(PublishedReport),
    can.share(SourcedReport),
    can.apply(closeReport),
  ],
})
const sourceViewer = defineRole("source.viewer", {
  grantedTo: [sourceViewers],
  grants: [can.view(Other)],
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
    actions: [acknowledge, closeReport],
    shares: [PublishedReport, SourcedReport],
    groups: [publishers, viewers, shareOnly, sourceViewers],
    roles: [publisher, viewer, shareManagerWithoutView, sourceViewer],
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

  // Reproduce: drop the linked-type check from shares/execution.ts; the publisher, who cannot
  // read sources, shares a report with the sources it links to.
  test("requires a whole view of every type the Share's links reach", async () => {
    const host = createHost()
    await createTestSixb(host).objects.upsert(Report.id, { id: "report-1" })
    const input = {
      target: objectRef(Report, "report-1"),
      destinationPath: "/reports/report-1",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }

    const denial = await principalSixb(host, [publishers.id])
      .shares.issue(SourcedReport, input)
      .catch((error) => error)
    expect(denial).toBeInstanceOf(AuthorizationError)
    expect(denial).toMatchObject({ grantKey: "view:object:other" })

    const invitation = await principalSixb(host, [publishers.id, sourceViewers.id]).shares.issue(
      SourcedReport,
      input
    )
    expect(invitation.grant.definitionId).toBe(SourcedReport.id)
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

// Reproduce: make `revocationActor` in shares/execution.ts return `managementPrincipal()` alone; the
// Action's and the workflow's revocations then fail as unauthenticated.
describe("Share revocation from trusted code", () => {
  async function issued(host: ReturnType<typeof createHost>) {
    await createTestSixb(host).objects.upsert(Report.id, { id: "report-1" })
    return principalSixb(host, [publishers.id]).shares.issue(PublishedReport, {
      target: objectRef(Report, "report-1"),
      destinationPath: "/reports/report-1",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    })
  }

  async function bindWorkflow(host: ReturnType<typeof createHost>) {
    const executionId = await createTestAutomaticWorkflowExecution(host.storage.executions, {
      projectId: host.id,
      workflowId: "close-requests",
      runId: "wfrun_close",
    })
    const execution = await host.storage.executions.getById({ projectId: host.id, id: executionId })
    if (!execution) throw new Error(`Expected workflow execution '${executionId}'.`)
    return bindDurablePrimitiveExecution(host, {
      execution,
      primitive: { kind: "workflow", id: "close-requests", runId: "wfrun_close" },
    }).sixb
  }

  test("an Action's effects revoke a grant as the Action", async () => {
    const host = createHost()
    const { grant } = await issued(host)
    await host.storage.auth!.users.create({
      projectId: host.id,
      id: "usr_publisher",
      email: "publisher@example.com",
    })
    revocations.length = 0

    const run = await principalSixb(host, [publishers.id])
      .objects(Report)
      .requestAction({ id: "report-1", actionId: closeReport.id, params: { grantId: grant.id } })
    await drainActionRuns(host, 5_000)

    expect(run.status).toBe("succeeded")
    expect(revocations).toEqual([
      expect.objectContaining({
        id: grant.id,
        revokedBy: { type: "system", id: "action:close-report" },
      }),
    ])
    expect(
      await host.storage.shareGrants?.getById({ projectId: host.id, id: grant.id })
    ).toHaveProperty("revokedBy", { type: "system", id: "action:close-report" })
  })

  test("a workflow step revokes a grant as the workflow", async () => {
    const host = createHost()
    const { grant } = await issued(host)
    const workflow = await bindWorkflow(host)

    const revoked = await workflow.shares.revoke(grant.id)

    expect(revoked).toMatchObject({
      id: grant.id,
      revokedBy: { type: "system", id: "workflow:close-requests" },
    })
    expect(revoked?.revokedAt).toBeInstanceOf(Date)
    // The first revocation stands, and an unknown grant is not found.
    expect(await workflow.shares.revoke(grant.id)).toEqual(revoked)
    expect(await workflow.shares.revoke("shr_missing")).toBeNull()
  })

  test("trusted code cannot issue or list links", async () => {
    const host = createHost()
    await issued(host)
    const workflow = await bindWorkflow(host)

    const issuing = await workflow.shares
      .issue(PublishedReport, {
        target: objectRef(Report, "report-1"),
        destinationPath: "/reports/report-1",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      })
      .catch((error: unknown) => error)
    expect(issuing).toBeInstanceOf(ShareError)
    expect(issuing).toHaveProperty("reason", "unauthenticated")

    const listing = await workflow.shares.list(PublishedReport).catch((error: unknown) => error)
    expect(listing).toHaveProperty("reason", "unauthenticated")
  })

  test("a shared session cannot revoke, even its own grant", async () => {
    const host = createHost()
    const { grant } = await issued(host)
    const access = (await host.storage.shareGrants?.getById({ projectId: host.id, id: grant.id }))
      ?.authoritySnapshot.access
    if (!access) throw new Error("Expected the grant's access plan.")
    const shared = host.withScope(
      createSharedTestScope({
        projectId: host.id,
        requestId: "req_shared",
        correlationId: "corr_shared",
        access,
        delegation: { kind: "share", grantId: grant.id, sessionId: "ses_shared" },
      })
    )

    const revoking = await shared.shares.revoke(grant.id).catch((error: unknown) => error)

    expect(revoking).toHaveProperty("reason", "unauthenticated")
    expect(
      await host.storage.shareGrants?.getById({ projectId: host.id, id: grant.id })
    ).not.toHaveProperty("revokedAt")
  })
})
