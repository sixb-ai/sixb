import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import {
  agentServiceAccountId,
  ensureManagedAgentExecutionIdentity,
  resolveAgentExecutionAuthorization,
  resolveInheritedAgentExecutionAuthorization,
} from "../src/agents/authority"
import { SecurityRegistry } from "../src/security"

const projectId = "agent-authority"
const userId = "user-1"
const now = new Date("2026-09-02T12:00:00.000Z")
const security = new SecurityRegistry({})

describe("conversation Agent authority", () => {
  test("revalidates access tokens and preserves their group constraint", async () => {
    const storage = new InMemoryStorage()
    await storage.auth.users.create({
      id: userId,
      projectId,
      email: "user@example.com",
      createdAt: now,
      updatedAt: now,
    })
    for (const groupId of ["allowed", "outside-token"]) {
      await storage.auth.groupMemberships.upsert({
        projectId,
        userId,
        groupId,
        source: "manual",
        createdAt: now,
      })
    }
    await storage.auth.accessTokens.create({
      id: "token-1",
      projectId,
      name: "Agent token",
      kind: "personal",
      subjectType: "user",
      subjectId: userId,
      tokenHash: "unused-after-admission",
      groupIds: ["allowed"],
      createdAt: now,
      expiresAt: new Date("2027-09-02T12:00:00.000Z"),
    })
    const ref = {
      type: "principal",
      principal: { type: "user", id: userId },
      credential: { type: "accessToken", id: "token-1" },
    } as const

    const resolved = await resolveInheritedAgentExecutionAuthorization({
      auth: storage.auth,
      projectId,
      authorizationRef: ref,
      security,
      now,
    })

    expect(resolved).toMatchObject({
      type: "principal",
      context: { principal: ref.principal, groupIds: ["allowed"] },
    })

    await storage.auth.accessTokens.revoke({
      projectId,
      id: "token-1",
      revokedAt: now,
    })
    await expect(
      resolveInheritedAgentExecutionAuthorization({
        auth: storage.auth,
        projectId,
        authorizationRef: ref,
        security,
        now,
      })
    ).rejects.toMatchObject({ code: "agent.execution_failed" })
  })
})

describe("managed agent authority", () => {
  test("does not adopt a service account created outside the Agent runtime", async () => {
    const storage = new InMemoryStorage()
    const actorId = "workflow:billing:step:review"
    const serviceAccountId = agentServiceAccountId(actorId)
    await storage.auth.serviceAccounts.create({
      id: serviceAccountId,
      projectId,
      name: "Conflicting account",
      createdByPrincipal: { type: "user", id: userId },
      createdAt: now,
      updatedAt: now,
    })

    await expect(
      ensureManagedAgentExecutionIdentity({
        auth: storage.auth,
        projectId,
        actorId,
        name: "Billing review",
        description: "Managed workflow Agent task.",
        groupIds: ["billing"],
      })
    ).rejects.toThrow(`service account '${serviceAccountId}' because it is not managed by Sixb`)
  })

  test("fails closed when a managed Agent receives an external group membership", async () => {
    const storage = new InMemoryStorage()
    const actorId = "workflow:billing:step:review"
    const identity = await ensureManagedAgentExecutionIdentity({
      auth: storage.auth,
      projectId,
      actorId,
      name: "Billing review",
      description: "Managed workflow Agent task.",
      groupIds: ["billing"],
    })
    await storage.auth.serviceAccountGroupMemberships.upsert({
      projectId,
      serviceAccountId: identity.serviceAccount.id,
      groupId: "administrators",
      source: "manual",
      createdAt: now,
    })

    await expect(
      resolveAgentExecutionAuthorization({
        auth: storage.auth,
        projectId,
        actorId,
        authorizationRef: { type: "principal", principal: identity.principal },
        security,
      })
    ).rejects.toThrow("group memberships not managed by its definition: administrators")
  })
})
