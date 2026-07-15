import { describe, expect, test } from "bun:test"
import { type AuthSessionAudience, InMemoryAuthStorage } from "@sixb/core"
import type { CompleteAuthSessionInput } from "@sixb/core/storage"
import { magicLink, type SendMagicLinkInput } from "../src"
import { hashMagicLinkToken } from "../src/tokens"

const projectId = "project-a"
const requestOrigin = "http://localhost"

function at(value: string): Date {
  return new Date(value)
}

function sessionInput(id = "ses_1"): CompleteAuthSessionInput {
  return {
    id,
    audience: "atlas",
    tokenHash: `${id}-hash`,
    createdAt: at("2026-05-16T10:05:00.000Z"),
    expiresAt: at("2026-05-23T10:05:00.000Z"),
  }
}

function createSender(options: { readonly fail?: boolean } = {}) {
  const messages: SendMagicLinkInput[] = []

  return {
    messages,
    async sendMagicLink(message: SendMagicLinkInput): Promise<void> {
      if (options.fail) {
        throw new Error("send failed")
      }
      messages.push(message)
    },
  }
}

function linkFromLatestMessage(messages: readonly { readonly text: string }[]): URL {
  const text = messages.at(-1)?.text ?? ""
  const match = text.match(/https?:\/\/\S+/)
  if (!match) {
    throw new Error("No magic link found in sent email")
  }
  return new URL(match[0])
}

async function requestMagicLink(input: {
  readonly storage: InMemoryAuthStorage
  readonly strategy: ReturnType<typeof magicLink>
  readonly email: string
  readonly audience?: AuthSessionAudience
  readonly requesterHash?: string
  readonly now?: Date
}) {
  return input.strategy.requestMagicLink({
    projectId,
    authStorage: input.storage,
    email: input.email,
    audience: input.audience ?? "atlas",
    returnTo: "/dashboard",
    requestOrigin,
    requesterHash: input.requesterHash,
    now: input.now ?? at("2026-05-16T10:00:00.000Z"),
  })
}

describe("magicLink", () => {
  test("requires allowed domains", () => {
    const { sendMagicLink } = createSender()

    expect(() =>
      magicLink({
        allowedDomains: [],
        sendMagicLink,
      })
    ).toThrow("allowedDomains")
  })

  test("uses exact allowed-domain matching", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_1",
      projectId,
      email: "ava@acme.com",
    })

    await expect(requestMagicLink({ storage, strategy, email: "ava@acme.com" })).resolves.toEqual({
      status: "sent",
    })
    await expect(
      requestMagicLink({
        storage,
        strategy,
        email: "ava@sales.acme.com",
        now: at("2026-05-16T10:02:00.000Z"),
      })
    ).resolves.toEqual({ status: "skipped" })

    expect(messages).toHaveLength(1)
  })

  test("validates invitation recipients before storage writes", async () => {
    const storage = new InMemoryAuthStorage()
    const { sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      rateLimit: { perMinute: 1, perHour: 1 },
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_active",
      projectId,
      email: "ava@acme.com",
    })
    await storage.users.create({
      id: "usr_suspended",
      projectId,
      email: "suspended@acme.com",
      status: "suspended",
    })

    await expect(
      strategy.validateInvitationRecipient!({
        projectId,
        authStorage: storage,
        email: " Ava@Acme.COM ",
        now: at("2026-05-16T10:00:00.000Z"),
      })
    ).resolves.toEqual({ status: "allowed", email: "ava@acme.com" })
    await expect(
      strategy.validateInvitationRecipient!({
        projectId,
        authStorage: storage,
        email: "ava@example.com",
        now: at("2026-05-16T10:00:00.000Z"),
      })
    ).resolves.toEqual({ status: "disallowed_domain", email: "ava@example.com" })
    await expect(
      strategy.validateInvitationRecipient!({
        projectId,
        authStorage: storage,
        email: "suspended@acme.com",
        now: at("2026-05-16T10:00:00.000Z"),
      })
    ).resolves.toEqual({ status: "suspended_user", email: "suspended@acme.com" })

    await requestMagicLink({
      storage,
      strategy,
      email: "ava@acme.com",
      now: at("2026-05-16T10:00:00.000Z"),
    })
    await expect(
      strategy.validateInvitationRecipient!({
        projectId,
        authStorage: storage,
        email: "ava@acme.com",
        now: at("2026-05-16T10:00:30.000Z"),
      })
    ).resolves.toEqual({ status: "rate_limited", email: "ava@acme.com" })
  })

  test("sends active users a hashed magic link", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_1",
      projectId,
      email: "ava@acme.com",
    })

    await expect(requestMagicLink({ storage, strategy, email: " Ava@Acme.COM " })).resolves.toEqual(
      { status: "sent" }
    )

    const link = linkFromLatestMessage(messages)
    const token = link.searchParams.get("token")
    const magicLinkId = link.searchParams.get("magicLinkId")

    expect(link.origin).toBe(requestOrigin)
    expect(link.pathname).toBe("/auth/callback")
    expect(link.searchParams.get("returnTo")).toBeNull()
    expect(link.searchParams.get("requester")).toBeNull()
    expect(token).toBeTruthy()
    expect(magicLinkId).toBeTruthy()

    const record = await storage.magicLinks.getById({
      projectId,
      id: magicLinkId ?? "",
    })
    expect(record).toMatchObject({
      email: "ava@acme.com",
      strategyId: "magic-link",
      audience: "atlas",
      returnTo: "/dashboard",
      tokenHash: hashMagicLinkToken(token ?? ""),
    })
    expect(record?.tokenHash).not.toBe(token)
  })

  test("embeds the requester hash in the callback URL when provided", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_1",
      projectId,
      email: "ava@acme.com",
    })

    await requestMagicLink({
      storage,
      strategy,
      email: "ava@acme.com",
      requesterHash: "requester-hash-value",
    })

    const link = linkFromLatestMessage(messages)
    expect(link.searchParams.get("requester")).toBe("requester-hash-value")
  })

  test("peekMagicLink validates without consuming and rejects bad tokens", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      bootstrapUsers: ["ava@acme.com"],
      sendMagicLink,
    })

    await requestMagicLink({ storage, strategy, email: "ava@acme.com" })
    const link = linkFromLatestMessage(messages)
    const magicLinkId = link.searchParams.get("magicLinkId") ?? ""
    const token = link.searchParams.get("token") ?? ""
    const peek = (peekToken: string, now?: Date) =>
      strategy.peekMagicLink!({
        projectId,
        authStorage: storage,
        magicLinkId,
        token: peekToken,
        now: now ?? at("2026-05-16T10:01:00.000Z"),
      })

    // Valid link peeks the email — repeatedly, without consuming it.
    await expect(peek(token)).resolves.toEqual({ email: "ava@acme.com" })
    await expect(peek(token)).resolves.toEqual({ email: "ava@acme.com" })
    await expect(peek("wrong-token")).resolves.toBeNull()
    await expect(peek(token, at("2026-05-16T10:16:00.000Z"))).resolves.toBeNull()

    // Completion still works after peeking, and a consumed link peeks null.
    await strategy.completeMagicLinkSignIn({
      projectId,
      authStorage: storage,
      magicLinkId,
      token,
      now: at("2026-05-16T10:02:00.000Z"),
      session: {
        id: "ses_1",
        audience: "atlas",
        tokenHash: "session-hash",
        createdAt: at("2026-05-16T10:02:00.000Z"),
        expiresAt: at("2026-05-16T22:02:00.000Z"),
      },
    })
    await expect(peek(token, at("2026-05-16T10:03:00.000Z"))).resolves.toBeNull()
  })

  test("does not send for unknown, suspended, or disallowed emails", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_suspended",
      projectId,
      email: "suspended@acme.com",
      status: "suspended",
    })

    await requestMagicLink({ storage, strategy, email: "unknown@acme.com" })
    await requestMagicLink({ storage, strategy, email: "suspended@acme.com" })
    await requestMagicLink({ storage, strategy, email: "ava@example.com" })

    expect(messages).toHaveLength(0)
    await expect(
      storage.magicLinks.getActiveByEmail({
        projectId,
        email: "unknown@acme.com",
        now: at("2026-05-16T10:01:00.000Z"),
      })
    ).resolves.toBeNull()
  })

  test("allows pending invitations to request a magic link", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      sendMagicLink,
    })

    await storage.invitations.createOrUpdateActive({
      id: "inv_1",
      projectId,
      email: "invited@acme.com",
      createdAt: at("2026-05-16T09:00:00.000Z"),
      expiresAt: at("2026-05-23T09:00:00.000Z"),
    })

    await expect(
      requestMagicLink({ storage, strategy, email: "invited@acme.com" })
    ).resolves.toEqual({ status: "sent" })
    expect(messages).toHaveLength(1)
  })

  test("allows bootstrap requests even after active users exist", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      bootstrapUsers: ["founder@acme.com"],
      sendMagicLink,
    })

    await expect(
      requestMagicLink({ storage, strategy, email: "founder@acme.com" })
    ).resolves.toEqual({ status: "sent" })

    // Another user now exists; a listed bootstrap user must still be able to
    // request a magic link (the allowlist is the trust boundary, not "first user only").
    await storage.users.create({
      id: "usr_existing",
      projectId,
      email: "existing@acme.com",
    })
    await expect(
      requestMagicLink({
        storage,
        strategy,
        email: "founder@acme.com",
        now: at("2026-05-16T10:02:00.000Z"),
      })
    ).resolves.toEqual({ status: "sent" })

    expect(messages).toHaveLength(2)
  })

  test("completes bootstrap magic-link sign-in and applies bootstrap groups", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      bootstrapUsers: ["founder@acme.com"],
      bootstrapGroups: ["security-admins"],
      sendMagicLink,
    })

    await requestMagicLink({ storage, strategy, email: "founder@acme.com" })
    const link = linkFromLatestMessage(messages)

    const result = await strategy.completeMagicLinkSignIn({
      projectId,
      authStorage: storage,
      magicLinkId: link.searchParams.get("magicLinkId") ?? "",
      token: link.searchParams.get("token") ?? "",
      session: sessionInput(),
      now: at("2026-05-16T10:05:00.000Z"),
    })

    expect(result.user.email).toBe("founder@acme.com")
    expect(result.session).toMatchObject({ id: "ses_1", strategyId: "magic-link" })
    expect(result).toMatchObject({ audience: "atlas", returnTo: "/dashboard" })
    await expect(
      storage.groupMemberships.listForUser({ projectId, userId: result.user.id })
    ).resolves.toMatchObject([{ groupId: "security-admins", source: "manual" }])
  })

  test("reconciles bootstrap groups for an existing user on later sign-in", async () => {
    const storage = new InMemoryAuthStorage()

    const first = createSender()
    const strategyV1 = magicLink({
      allowedDomains: ["acme.com"],
      bootstrapUsers: ["founder@acme.com"],
      bootstrapGroups: ["security-admins"],
      sendMagicLink: first.sendMagicLink,
    })
    await requestMagicLink({ storage, strategy: strategyV1, email: "founder@acme.com" })
    const firstLink = linkFromLatestMessage(first.messages)
    const created = await strategyV1.completeMagicLinkSignIn({
      projectId,
      authStorage: storage,
      magicLinkId: firstLink.searchParams.get("magicLinkId") ?? "",
      token: firstLink.searchParams.get("token") ?? "",
      session: sessionInput("ses_1"),
      now: at("2026-05-16T10:05:00.000Z"),
    })
    await expect(
      storage.groupMemberships.listForUser({ projectId, userId: created.user.id })
    ).resolves.toMatchObject([{ groupId: "security-admins", source: "manual" }])

    // A newly-added bootstrap group must reach the already-existing bootstrap user
    // on their next sign-in, not only at first creation.
    const second = createSender()
    const strategyV2 = magicLink({
      allowedDomains: ["acme.com"],
      bootstrapUsers: ["founder@acme.com"],
      bootstrapGroups: ["security-admins", "billing-admins"],
      sendMagicLink: second.sendMagicLink,
    })
    await requestMagicLink({
      storage,
      strategy: strategyV2,
      email: "founder@acme.com",
      now: at("2026-05-17T10:00:00.000Z"),
    })
    const secondLink = linkFromLatestMessage(second.messages)
    const reSignIn = await strategyV2.completeMagicLinkSignIn({
      projectId,
      authStorage: storage,
      magicLinkId: secondLink.searchParams.get("magicLinkId") ?? "",
      token: secondLink.searchParams.get("token") ?? "",
      session: sessionInput("ses_2"),
      now: at("2026-05-17T10:05:00.000Z"),
    })

    expect(reSignIn.user.id).toBe(created.user.id)
    const groupIds = (
      await storage.groupMemberships.listForUser({ projectId, userId: reSignIn.user.id })
    ).map((membership) => membership.groupId)
    expect(groupIds).toContain("security-admins")
    expect(groupIds).toContain("billing-admins")
  })

  test("invalidates the previous active magic link when requesting a new one", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      rateLimit: false,
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_1",
      projectId,
      email: "ava@acme.com",
    })

    await requestMagicLink({ storage, strategy, email: "ava@acme.com" })
    const firstId = linkFromLatestMessage(messages).searchParams.get("magicLinkId") ?? ""
    await requestMagicLink({
      storage,
      strategy,
      email: "ava@acme.com",
      now: at("2026-05-16T10:02:00.000Z"),
    })
    const secondId = linkFromLatestMessage(messages).searchParams.get("magicLinkId") ?? ""

    await expect(storage.magicLinks.getById({ projectId, id: firstId })).resolves.toMatchObject({
      revokedAt: at("2026-05-16T10:02:00.000Z"),
    })
    const second = await storage.magicLinks.getById({ projectId, id: secondId })
    expect(second?.revokedAt).toBeUndefined()
  })

  test("rate limits by normalized email", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      rateLimit: { perMinute: 5, perHour: 5 },
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_1",
      projectId,
      email: "ava@acme.com",
    })

    for (let index = 0; index < 5; index++) {
      await expect(
        requestMagicLink({
          storage,
          strategy,
          email: " AVA@ACME.COM ",
          now: new Date(at("2026-05-16T10:00:00.000Z").getTime() + index * 60_000),
        })
      ).resolves.toEqual({ status: "sent" })
    }

    await expect(
      requestMagicLink({
        storage,
        strategy,
        email: "ava@acme.com",
        now: at("2026-05-16T10:06:00.000Z"),
      })
    ).resolves.toEqual({ status: "rate_limited" })
    expect(messages).toHaveLength(5)
  })

  test("applies default rate limit of 5/minute", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_1",
      projectId,
      email: "ava@acme.com",
    })

    for (let index = 0; index < 5; index++) {
      await expect(
        requestMagicLink({
          storage,
          strategy,
          email: "ava@acme.com",
          now: new Date(at("2026-05-16T10:00:00.000Z").getTime() + index * 5_000),
        })
      ).resolves.toEqual({ status: "sent" })
    }

    await expect(
      requestMagicLink({
        storage,
        strategy,
        email: "ava@acme.com",
        now: at("2026-05-16T10:00:30.000Z"),
      })
    ).resolves.toEqual({ status: "rate_limited" })
    expect(messages).toHaveLength(5)
  })

  test("allows a multi-audience login burst under defaults", async () => {
    const storage = new InMemoryAuthStorage()
    const { messages, sendMagicLink } = createSender()
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_1",
      projectId,
      email: "ava@acme.com",
    })

    for (const audience of ["atlas", "app"] as const) {
      await expect(
        requestMagicLink({
          storage,
          strategy,
          email: "ava@acme.com",
          audience,
          now: at("2026-05-16T10:00:00.000Z"),
        })
      ).resolves.toEqual({ status: "sent" })
    }

    expect(messages).toHaveLength(2)
  })

  test("revokes the created magic link if sending fails", async () => {
    const storage = new InMemoryAuthStorage()
    const { sendMagicLink } = createSender({ fail: true })
    const strategy = magicLink({
      allowedDomains: ["acme.com"],
      sendMagicLink,
    })

    await storage.users.create({
      id: "usr_1",
      projectId,
      email: "ava@acme.com",
    })

    await expect(requestMagicLink({ storage, strategy, email: "ava@acme.com" })).rejects.toThrow(
      "send failed"
    )
    await expect(
      storage.magicLinks.getActiveByEmail({
        projectId,
        email: "ava@acme.com",
        now: at("2026-05-16T10:01:00.000Z"),
      })
    ).resolves.toBeNull()
  })
})
