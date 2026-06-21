import { describe, expect, test } from "bun:test"
import {
  createSessionCredential,
  defineGroup,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  Sixb,
} from "@sixb/core"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "test-project"
const agents = defineGroup("agents", { label: "Agents" })
const admins = defineGroup("admins", { label: "Admins" })
const authStrategy = {
  id: "test",
  kind: "dev" as const,
}

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

function createRuntime() {
  const storage = new InMemoryStorage()
  const sixb = new Sixb<readonly OntologySource[]>({
    id: projectId,
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [agents, admins],
    auth: authStrategy,
  })

  return {
    app: createSixbApi(
      new SixbServer({
        sixb,
        quiet: true,
        browser: createTestBrowserPolicy(),
      })
    ),
    storage,
  }
}

async function seedSession(storage: InMemoryStorage) {
  const credential = createSessionCredential("ses_management")
  await storage.auth.users.create({
    id: "usr_1",
    projectId,
    email: "ava@acme.com",
    displayName: "Ava Chen",
  })
  await storage.auth.groupMemberships.upsert({
    projectId,
    userId: "usr_1",
    groupId: "agents",
    source: "manual",
  })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId: "usr_1",
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  return {
    headers: {
      cookie: `sixb_session=${credential.cookieValue}; sixb_csrf=csrf_1`,
      "x-sixb-csrf": "csrf_1",
    },
  }
}

function jsonRequest(path: string, method: string, headers: HeadersInit, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe("access token management routes", () => {
  test("creates, lists, and revokes the caller's personal access tokens", async () => {
    const { app, storage } = createRuntime()
    const session = await seedSession(storage)

    const optionsResponse = await app.fetch(
      jsonRequest("/api/auth/access-management-options", "GET", session.headers)
    )
    expect(optionsResponse.status).toBe(200)
    await expect(optionsResponse.json()).resolves.toEqual({
      groups: [{ id: "agents", label: "Agents" }],
    })

    const deniedResponse = await app.fetch(
      jsonRequest("/api/auth/access-tokens", "POST", session.headers, {
        name: "Escalated",
        expiresAt: "2099-01-01T00:00:00.000Z",
        groupIds: ["admins"],
      })
    )
    expect(deniedResponse.status).toBe(403)

    const createResponse = await app.fetch(
      jsonRequest("/api/auth/access-tokens", "POST", session.headers, {
        name: "Local CLI",
        expiresAt: "2099-01-01T00:00:00.000Z",
        groupIds: ["agents"],
      })
    )
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as {
      accessToken: { readonly id: string; readonly groupIds?: readonly string[] }
      tokenValue: string
    }
    expect(created.tokenValue.startsWith("sixb_pat_")).toBe(true)
    expect(created.accessToken.groupIds).toEqual(["agents"])

    const listResponse = await app.fetch(
      jsonRequest("/api/auth/access-tokens", "GET", session.headers)
    )
    expect(listResponse.status).toBe(200)
    const listed = (await listResponse.json()) as {
      accessTokens: readonly { readonly id: string; readonly tokenValue?: string }[]
    }
    expect(listed.accessTokens.map((token) => token.id)).toEqual([created.accessToken.id])
    expect("tokenValue" in listed.accessTokens[0]).toBe(false)

    const revokeResponse = await app.fetch(
      jsonRequest(
        `/api/auth/access-tokens/${created.accessToken.id}/revoke`,
        "POST",
        session.headers
      )
    )
    expect(revokeResponse.status).toBe(200)
    await expect(revokeResponse.json()).resolves.toMatchObject({
      accessToken: { id: created.accessToken.id, status: "revoked" },
    })
  })

  test("creates, disables, and manages service-account tokens", async () => {
    const { app, storage } = createRuntime()
    const session = await seedSession(storage)

    const createAccountResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts", "POST", session.headers, {
        id: "svc_agents",
        name: "Agents",
        description: "Sandbox agents",
        groupIds: ["agents"],
      })
    )
    expect(createAccountResponse.status).toBe(201)
    await expect(createAccountResponse.json()).resolves.toMatchObject({
      serviceAccount: {
        id: "svc_agents",
        name: "Agents",
        status: "active",
        groupIds: ["agents"],
      },
    })

    const createTokenResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts/svc_agents/access-tokens", "POST", session.headers, {
        name: "Sandbox token",
        expiresAt: "2099-01-01T00:00:00.000Z",
        groupIds: ["agents"],
      })
    )
    expect(createTokenResponse.status).toBe(201)
    const createdToken = (await createTokenResponse.json()) as {
      accessToken: { readonly id: string; readonly groupIds?: readonly string[] }
      tokenValue: string
    }
    expect(createdToken.tokenValue.startsWith("sixb_sat_")).toBe(true)
    expect(createdToken.accessToken.groupIds).toEqual(["agents"])

    const listTokensResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts/svc_agents/access-tokens", "GET", session.headers)
    )
    expect(listTokensResponse.status).toBe(200)
    await expect(listTokensResponse.json()).resolves.toMatchObject({
      accessTokens: [{ id: createdToken.accessToken.id, subjectId: "svc_agents" }],
    })

    const revokeTokenResponse = await app.fetch(
      jsonRequest(
        `/api/auth/service-accounts/svc_agents/access-tokens/${createdToken.accessToken.id}/revoke`,
        "POST",
        session.headers
      )
    )
    expect(revokeTokenResponse.status).toBe(200)
    await expect(revokeTokenResponse.json()).resolves.toMatchObject({
      accessToken: { id: createdToken.accessToken.id, status: "revoked" },
    })

    const disableResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts/svc_agents/disable", "POST", session.headers)
    )
    expect(disableResponse.status).toBe(200)
    await expect(disableResponse.json()).resolves.toMatchObject({
      serviceAccount: { id: "svc_agents", status: "suspended" },
    })
    await expect(
      storage.auth.serviceAccounts.getById({ projectId, id: "svc_agents" })
    ).resolves.toMatchObject({ status: "suspended" })
  })
})
