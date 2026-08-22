import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  AuthorizationError,
  can,
  defineAction,
  defineObjectType,
  defineShareType,
  param,
  prop,
  SixbHost,
} from "../src"
import type { SharedAccessSessionContext } from "../src/shares/protocol"
import { bindSharedAccessExecution } from "../src/shares/runtime"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Report = defineObjectType({
  id: "shared-execution-report",
  name: "Shared execution report",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
  ],
})
const acknowledge = defineAction("shared-execution-acknowledge")
  .on(Report)
  .params({ note: param("string") })
  .writeback(async () => {})
const archive = defineAction("shared-execution-archive")
  .on(Report)
  .params({})
  .writeback(async () => {})
const PublishedReport = defineShareType({
  id: "shared-execution-published-report",
  target: Report,
  grants: [can.view(Report), can.apply(acknowledge)],
})

describe("shared access execution", () => {
  test("fixes the target and records shared authority for delegated Actions", async () => {
    const fixture = await createFixture()
    const shared = bindSharedAccessExecution(fixture.host, {
      request: new Request("https://api.test/api/shares/shr_1/resource", {
        headers: { "x-request-id": "request-shared", "x-correlation-id": "shared-correlation" },
      }),
      context: sharedContext(),
    })

    expect(Object.keys(shared)).toEqual(["getResource", "requestAction"])
    await expect(shared.getResource()).resolves.toMatchObject({
      objectTypeId: Report.id,
      primaryId: "report-1",
      properties: { id: "report-1", title: "Published" },
    })

    const requested = await shared.requestAction(acknowledge.id, {
      params: { note: "reviewed" },
      runId: "run-shared-action",
    })
    const run = await fixture.storage.actionRuns?.getById({
      projectId: fixture.host.id,
      id: requested.runId,
    })
    expect(run).toMatchObject({
      actionId: acknowledge.id,
      subject: { kind: "object", objectTypeId: Report.id, primaryId: "report-1" },
      params: { note: "reviewed" },
    })

    const childExecution = run
      ? await fixture.storage.executions.getById({
          projectId: fixture.host.id,
          id: run.executionId,
        })
      : null
    expect(childExecution).toMatchObject({
      source: { type: "execution" },
      correlationId: "shared-correlation",
    })
    expect(childExecution?.requestedBy).toBeUndefined()
    if (!childExecution || childExecution.source.type !== "execution") {
      throw new Error("Expected a child Action execution")
    }
    await expect(
      fixture.storage.executions.getById({
        projectId: fixture.host.id,
        id: childExecution.source.executionId,
      })
    ).resolves.toMatchObject({
      executor: { type: "request", requestId: "request-shared" },
      authorizationRef: {
        type: "sharedAccess",
        grantId: "shr_1",
        sessionId: "shs_1",
      },
    })
  })

  test("denies capabilities outside the effective snapshot", async () => {
    const fixture = await createFixture()
    const shared = bindSharedAccessExecution(fixture.host, {
      request: new Request("https://api.test/api/shares/shr_1/actions/archive"),
      context: sharedContext(),
    })

    await expect(shared.requestAction(archive.id)).rejects.toThrow(
      "Shared access grant 'shr_1' is not allowed to apply action"
    )
    await expect(shared.requestAction(archive.id)).rejects.toBeInstanceOf(AuthorizationError)
  })

  test("rejects inconsistent session context before binding authority", async () => {
    const fixture = await createFixture()
    expect(() =>
      bindSharedAccessExecution(fixture.host, {
        request: new Request("https://api.test/api/shares/shr_other/resource"),
        context: {
          ...sharedContext(),
          principal: { type: "sharedAccess", grantId: "shr_other", sessionId: "shs_1" },
        },
      })
    ).toThrow("inconsistent grant or session identity")
  })
})

async function createFixture() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "shared-execution-project",
    ontology: [Report],
    actions: [acknowledge as ActionDefinition, archive as ActionDefinition],
    shares: [PublishedReport],
    ...deps,
  })
  await createTestSixb(host).objects.upsert(Report.id, {
    id: "report-1",
    title: "Published",
  })
  return { host, storage: deps.storage }
}

function sharedContext(): SharedAccessSessionContext {
  const createdAt = new Date("2026-08-22T12:00:00.000Z")
  const expiresAt = new Date("2026-08-22T12:15:00.000Z")
  return {
    principal: { type: "sharedAccess", grantId: "shr_1", sessionId: "shs_1" },
    grant: {
      id: "shr_1",
      projectId: "shared-execution-project",
      shareTypeId: PublishedReport.id,
      target: { objectTypeId: Report.id, primaryId: "report-1" },
      issuedBy: { type: "user", id: "usr_1" },
      grants: [
        { capability: "view", objectTypeId: Report.id },
        { capability: "apply", actionId: acknowledge.id },
      ],
      tokenDigest: "digest",
      createdAt,
      expiresAt,
    },
    effectiveGrants: [
      { capability: "view", objectTypeId: Report.id },
      { capability: "apply", actionId: acknowledge.id },
    ],
    session: {
      id: "shs_1",
      projectId: "shared-execution-project",
      grantId: "shr_1",
      tokenDigest: "session-digest",
      createdAt,
      expiresAt,
    },
  }
}
