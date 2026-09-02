import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { resolveInheritedMainAgentExecutionAuthorization } from "../src/agents/authority"
import { SecurityRegistry } from "../src/security"

const projectId = "main-agent-authority"
const userId = "user-1"
const now = new Date("2026-09-02T12:00:00.000Z")
const security = new SecurityRegistry({})

describe("main agent authority", () => {
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

    const resolved = await resolveInheritedMainAgentExecutionAuthorization({
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
      resolveInheritedMainAgentExecutionAuthorization({
        auth: storage.auth,
        projectId,
        authorizationRef: ref,
        security,
        now,
      })
    ).rejects.toMatchObject({ code: "agent.execution_failed" })
  })
})
