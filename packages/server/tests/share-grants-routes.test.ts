import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShareType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Report = defineObjectType({
  id: "report",
  name: "Report",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const PublishedReport = defineShareType({
  id: "published-report",
  target: Report,
  grants: [can.view(Report)],
})

const publishers = defineGroup("publishers")
const publisher = defineRole("publisher", {
  grantedTo: [publishers],
  grants: [can.view(Report), can.share(PublishedReport)],
})

async function createFixture(
  options: { readonly includeApp?: boolean; readonly auth?: boolean } = {}
) {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: "project-1",
    ontology: [Report],
    shares: [PublishedReport],
    groups: [publishers],
    roles: [publisher],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: options.auth === false ? undefined : { id: "test", kind: "dev" as const },
  })
  await createTestSixb(host).objects.upsert(Report.id, { id: "report-1" })
  const app = createSixbApi(
    new SixbServer({
      host,
      quiet: true,
      browser: createTestBrowserPolicy({ includeApp: options.includeApp }),
    })
  )
  return { app, storage }
}

async function seedSession(storage: InMemoryStorage, groupIds: readonly string[]) {
  const credential = createSessionCredential("ses_publisher")
  await storage.auth.users.create({
    id: "usr_publisher",
    projectId: "project-1",
    email: "publisher@acme.test",
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: "project-1",
      userId: "usr_publisher",
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "project-1",
    userId: "usr_publisher",
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-08-19T12:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  })
  return {
    read: { cookie: `sixb_session=${credential.cookieValue}` },
    write: {
      cookie: `sixb_session=${credential.cookieValue}; sixb_csrf=csrf_1`,
      "x-sixb-csrf": "csrf_1",
      "content-type": "application/json",
    },
  }
}

describe("share grant routes", () => {
  test("returns the fragment link once and manages grants through normal auth", async () => {
    const { app, storage } = await createFixture()
    const session = await seedSession(storage, [publishers.id])

    const issued = await app.fetch(
      new Request("http://api.localhost/api/share-grants", {
        method: "POST",
        headers: session.write,
        body: JSON.stringify({
          shareTypeId: PublishedReport.id,
          target: { objectTypeId: Report.id, primaryId: "report-1" },
          expiresAt: "2098-01-01T00:00:00.000Z",
        }),
      })
    )
    const invitation = (await issued.json()) as {
      grant: { id: string; tokenDigest?: string; issuedBy: { id: string } }
      url: string
    }

    expect(issued.status).toBe(201)
    expect(issued.headers.get("cache-control")).toBe("no-store")
    expect(invitation.grant.tokenDigest).toBeUndefined()
    expect(invitation.grant.issuedBy.id).toBe("usr_publisher")
    const link = new URL(invitation.url)
    expect(link.origin).toBe("http://app.localhost")
    expect(link.pathname).toBe(`/shared/${PublishedReport.id}/${invitation.grant.id}`)
    expect(link.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/)

    const listed = await app.fetch(
      new Request(
        `http://api.localhost/api/share-grants?shareTypeId=${PublishedReport.id}&objectTypeId=${Report.id}&primaryId=report-1`,
        { headers: session.read }
      )
    )
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ grants: [{ id: invitation.grant.id }] })

    const revoked = await app.fetch(
      new Request(`http://api.localhost/api/share-grants/${invitation.grant.id}`, {
        method: "DELETE",
        headers: session.write,
      })
    )
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ id: invitation.grant.id })
  })

  test("denies anonymous, ungranted, and auth-disabled issuance", async () => {
    const authenticated = await createFixture()
    const noGrant = await seedSession(authenticated.storage, [])
    const requestBody = JSON.stringify({
      shareTypeId: PublishedReport.id,
      target: { objectTypeId: Report.id, primaryId: "report-1" },
      expiresAt: "2098-01-01T00:00:00.000Z",
    })

    const anonymous = await authenticated.app.fetch(
      new Request("http://api.localhost/api/share-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      })
    )
    expect(anonymous.status).toBe(401)

    const forbidden = await authenticated.app.fetch(
      new Request("http://api.localhost/api/share-grants", {
        method: "POST",
        headers: noGrant.write,
        body: requestBody,
      })
    )
    expect(forbidden.status).toBe(403)

    const disabled = await createFixture({ auth: false })
    const withoutAuth = await disabled.app.fetch(
      new Request("http://api.localhost/api/share-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      })
    )
    expect(withoutAuth.status).toBe(401)
  })

  test("requires an app origin when constructing a server with share types", async () => {
    await expect(createFixture({ includeApp: false })).rejects.toThrow(
      "Registered share types require an allowed browser origin for the 'app' audience"
    )
  })
})
