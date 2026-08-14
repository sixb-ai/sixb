import { describe, expect, test } from "bun:test"
import {
  defineGroup,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  SixbHost,
} from "@sixb/core"
import { createAccessTokenCredential, createSessionCredential } from "@sixb/core/internal/auth"
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
  const sixb = new SixbHost<readonly OntologySource[]>({
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
        host: sixb,
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

async function seedPersonalAccessToken(storage: InMemoryStorage, name = "CLI bootstrap token") {
  const credential = createAccessTokenCredential("personal")
  await storage.auth.accessTokens.create({
    id: credential.tokenId,
    projectId,
    name,
    kind: "personal",
    subjectType: "user",
    subjectId: "usr_1",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  return credential
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

  test("allows personal access tokens to manage the caller's personal tokens", async () => {
    const { app, storage } = createRuntime()
    await seedSession(storage)
    const credential = await seedPersonalAccessToken(storage)
    const bearerHeaders = { authorization: `Bearer ${credential.tokenValue}` }

    const listResponse = await app.fetch(
      jsonRequest("/api/auth/access-tokens", "GET", bearerHeaders)
    )
    expect(listResponse.status).toBe(200)
    await expect(listResponse.json()).resolves.toMatchObject({
      accessTokens: [{ id: credential.tokenId, name: "CLI bootstrap token" }],
    })

    const createResponse = await app.fetch(
      jsonRequest("/api/auth/access-tokens", "POST", bearerHeaders, {
        name: "Rotated CLI token",
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

    const revokeResponse = await app.fetch(
      jsonRequest(`/api/auth/access-tokens/${created.accessToken.id}/revoke`, "POST", bearerHeaders)
    )
    expect(revokeResponse.status).toBe(200)
    await expect(revokeResponse.json()).resolves.toMatchObject({
      accessToken: { id: created.accessToken.id, status: "revoked" },
    })
  })

  test("allows personal access tokens to manage service accounts and service-account tokens", async () => {
    const { app, storage } = createRuntime()
    await seedSession(storage)
    const credential = await seedPersonalAccessToken(storage)
    const bearerHeaders = { authorization: `Bearer ${credential.tokenValue}` }

    const createAccountResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts", "POST", bearerHeaders, {
        id: "svc_cli",
        name: "CLI Service",
        description: "CLI managed service account",
        groupIds: ["agents"],
      })
    )
    expect(createAccountResponse.status).toBe(201)
    await expect(createAccountResponse.json()).resolves.toMatchObject({
      serviceAccount: {
        id: "svc_cli",
        name: "CLI Service",
        status: "active",
        groupIds: ["agents"],
      },
    })

    const createTokenResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts/svc_cli/access-tokens", "POST", bearerHeaders, {
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
      jsonRequest("/api/auth/service-accounts/svc_cli/access-tokens", "GET", bearerHeaders)
    )
    expect(listTokensResponse.status).toBe(200)
    await expect(listTokensResponse.json()).resolves.toMatchObject({
      accessTokens: [{ id: createdToken.accessToken.id, subjectId: "svc_cli" }],
    })

    const revokeTokenResponse = await app.fetch(
      jsonRequest(
        `/api/auth/service-accounts/svc_cli/access-tokens/${createdToken.accessToken.id}/revoke`,
        "POST",
        bearerHeaders
      )
    )
    expect(revokeTokenResponse.status).toBe(200)
    await expect(revokeTokenResponse.json()).resolves.toMatchObject({
      accessToken: { id: createdToken.accessToken.id, status: "revoked" },
    })

    const disableResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts/svc_cli/disable", "POST", bearerHeaders)
    )
    expect(disableResponse.status).toBe(200)
    await expect(disableResponse.json()).resolves.toMatchObject({
      serviceAccount: { id: "svc_cli", status: "suspended" },
    })
  })

  test("does not let service-account tokens manage credentials", async () => {
    const { app, storage } = createRuntime()
    const session = await seedSession(storage)
    await app.fetch(
      jsonRequest("/api/auth/service-accounts", "POST", session.headers, {
        id: "svc_agents",
        name: "Agents",
        groupIds: ["agents"],
      })
    )
    const tokenResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts/svc_agents/access-tokens", "POST", session.headers, {
        name: "Sandbox token",
        expiresAt: "2099-01-01T00:00:00.000Z",
        groupIds: ["agents"],
      })
    )
    const created = (await tokenResponse.json()) as { readonly tokenValue: string }

    const response = await app.fetch(
      jsonRequest("/api/auth/access-tokens", "GET", {
        authorization: `Bearer ${created.tokenValue}`,
      })
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "User authentication is required" })

    const serviceAccountsResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts", "GET", {
        authorization: `Bearer ${created.tokenValue}`,
      })
    )
    expect(serviceAccountsResponse.status).toBe(403)
    await expect(serviceAccountsResponse.json()).resolves.toEqual({
      error: "User authentication is required",
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
    // Disabling preserves fields the request did not touch (e.g. description).
    await expect(disableResponse.json()).resolves.toMatchObject({
      serviceAccount: { id: "svc_agents", status: "suspended", description: "Sandbox agents" },
    })
    await expect(
      storage.auth.serviceAccounts.getById({ projectId, id: "svc_agents" })
    ).resolves.toMatchObject({ status: "suspended", description: "Sandbox agents" })
  })

  test("hides and refuses management of service accounts the caller cannot fully govern", async () => {
    const { app, storage } = createRuntime()
    const session = await seedSession(storage)

    // A privileged service account in a group the caller (usr_1 in "agents")
    // does not belong to — e.g. one an admin created for privileged automation.
    await storage.auth.serviceAccounts.create({
      id: "svc_admin",
      projectId,
      name: "Admin worker",
    })
    await storage.auth.serviceAccountGroupMemberships.upsert({
      projectId,
      serviceAccountId: "svc_admin",
      groupId: "admins",
      source: "manual",
    })

    // The privileged account is invisible in the catalog.
    const listResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts", "GET", session.headers)
    )
    expect(listResponse.status).toBe(200)
    const listed = (await listResponse.json()) as {
      serviceAccounts: readonly { readonly id: string }[]
    }
    expect(listed.serviceAccounts.map((account) => account.id)).not.toContain("svc_admin")

    // Minting a token for it (the escalation vector) is refused as not-found.
    const mintResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts/svc_admin/access-tokens", "POST", session.headers, {
        name: "Escalated",
        expiresAt: "2099-01-01T00:00:00.000Z",
        groupIds: ["admins"],
      })
    )
    expect(mintResponse.status).toBe(404)

    // Listing its tokens and disabling it are likewise refused.
    const listTokensResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts/svc_admin/access-tokens", "GET", session.headers)
    )
    expect(listTokensResponse.status).toBe(404)

    const disableResponse = await app.fetch(
      jsonRequest("/api/auth/service-accounts/svc_admin/disable", "POST", session.headers)
    )
    expect(disableResponse.status).toBe(404)

    // The privileged account remains active and untouched.
    await expect(
      storage.auth.serviceAccounts.getById({ projectId, id: "svc_admin" })
    ).resolves.toMatchObject({ status: "active" })
  })
})
