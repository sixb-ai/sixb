import { oidc, type SendOidcInvitationInput } from "@pario/auth-oidc"
import { LocalBlobStorage } from "@pario/blob-local"
import { createPario, InMemoryBroker, InMemoryQueues } from "@pario/core"
import { LocalLakeStorage } from "@pario/lake-local"
import { SqliteStorage } from "@pario/sqlite"
import { securityAdmins } from "./security/groups/security-admins"

const blobStorage = new LocalBlobStorage({ basePath: ".pario" })
const authAllowedDomains = listEnv("PARIO_AUTH_ALLOWED_DOMAINS", ["sixb.ai"])
const authBootstrapUsers = listEnv("PARIO_AUTH_BOOTSTRAP_USERS", [
  "daniel@sixb.ai",
  "anthony@sixb.ai",
  "quentin@sixb.ai",
])
const authFromEmail = process.env.PARIO_AUTH_EMAIL_FROM?.trim()

export const pario = createPario({
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".pario" }),
  lakeStorage: new LocalLakeStorage({ path: ".pario/lake" }),
  blobStorage,
  queues: new InMemoryQueues(),
  auth: oidc({
    id: "google-workspace",
    issuer: "https://accounts.google.com",
    clientId: requiredEnv("PARIO_GOOGLE_CLIENT_ID"),
    clientSecret: requiredEnv("PARIO_GOOGLE_CLIENT_SECRET"),
    allowedDomains: authAllowedDomains,
    bootstrapUsers: authBootstrapUsers,
    bootstrapGroups: [securityAdmins],
    publicUrl: process.env.PARIO_PUBLIC_URL,
    from: authFromEmail,
    sendInvitation: sendAuthInvitation,
  }),
})

async function sendAuthInvitation(message: SendOidcInvitationInput): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: message.from ?? requiredEnv("PARIO_AUTH_FROM_EMAIL"),
      to: [message.email],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(
      `[AcmeCorp] Resend invitation email failed (${response.status}): ${
        body || response.statusText
      }`
    )
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`[AcmeCorp] ${name} is required for Google Workspace OIDC auth.`)
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
