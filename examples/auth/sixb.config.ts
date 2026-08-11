import { magicLink, type SendMagicLinkInput } from "@sixb/auth-magic-link"
import { oidc, type SendOidcInvitationInput } from "@sixb/auth-oidc"
import {
  createSixb,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
} from "@sixb/core"
import { migrateSqliteStorage, SqliteStorage } from "@sixb/sqlite"
import { securityAdmins } from "./security/groups/security-admins"

// Switch the auth strategy with SIXB_AUTH_MODE:
//   magic-link (default) — zero setup; the sign-in link is printed to this terminal.
//   oidc                 — set SIXB_GOOGLE_CLIENT_ID and SIXB_GOOGLE_CLIENT_SECRET.
// Set RESEND_API_KEY (+ SIXB_AUTH_EMAIL_FROM) to actually deliver the emails via Resend.
const authMode = (process.env.SIXB_AUTH_MODE ?? "magic-link").trim()
const fromEmail = process.env.SIXB_AUTH_EMAIL_FROM?.trim()

const allowedDomains = listEnv("SIXB_AUTH_ALLOWED_DOMAINS", ["example.com"])
const bootstrapUsers = listEnv("SIXB_AUTH_BOOTSTRAP_USERS", ["admin@example.com"])
const storagePath = ".sixb"

export const sixb = createAuthExampleSixb()

async function createAuthExampleSixb() {
  await migrateSqliteStorage(storagePath)

  return createSixb({
    id: "auth-example",
    broker: new InMemoryBroker(),
    storage: new SqliteStorage({ path: storagePath }),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth:
      authMode === "oidc"
        ? oidc({
            id: "google-workspace",
            issuer: "https://accounts.google.com",
            clientId: requiredEnv("SIXB_GOOGLE_CLIENT_ID"),
            clientSecret: requiredEnv("SIXB_GOOGLE_CLIENT_SECRET"),
            allowedDomains,
            bootstrapUsers,
            bootstrapGroups: [securityAdmins],
            from: fromEmail,
            sendInvitation: sendAuthInvitation,
          })
        : magicLink({
            allowedDomains,
            bootstrapUsers,
            bootstrapGroups: [securityAdmins],
            from: fromEmail,
            sendMagicLink: sendMagicLinkEmail,
          }),
  })
}

async function sendMagicLinkEmail(message: SendMagicLinkInput): Promise<void> {
  // Print the link so you can sign in even without an email provider configured.
  console.log(`\n[auth] Magic sign-in link for ${message.email}:\n${message.url}\n`)

  if (!process.env.RESEND_API_KEY?.trim()) {
    return
  }

  await sendResendEmail({
    from: message.from,
    to: message.email,
    subject: message.subject,
    text: message.text,
    html: message.html,
  })
}

async function sendAuthInvitation(message: SendOidcInvitationInput): Promise<void> {
  console.log(`\n[auth] Invitation for ${message.email}:\n${message.text}\n`)

  if (!process.env.RESEND_API_KEY?.trim()) {
    return
  }

  await sendResendEmail({
    from: message.from,
    to: message.email,
    subject: message.subject,
    text: message.text,
    html: message.html,
  })
}

async function sendResendEmail(input: {
  readonly from?: string
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html: string
}): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: input.from ?? requiredEnv("SIXB_AUTH_EMAIL_FROM"),
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(
      `[auth-example] Resend email failed (${response.status}): ${body || response.statusText}`
    )
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`[auth-example] ${name} is required.`)
  }
  return value
}

function listEnv(name: string, fallback: readonly string[]): readonly string[] {
  const raw = process.env[name]?.trim()
  if (!raw) {
    return fallback
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}
