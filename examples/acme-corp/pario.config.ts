import { magicLink } from "@pario/auth-magic-link"
import { LocalBlobStorage } from "@pario/blob-local"
import { createPario, InMemoryBroker, InMemoryQueues } from "@pario/core"
import { LocalLakeStorage } from "@pario/lake-local"
import { SqliteStorage } from "@pario/sqlite"
import { Resend } from "resend"
import { securityAdmins } from "./security/groups/security-admins"

const blobStorage = new LocalBlobStorage({ basePath: ".pario" })
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const authEmailFrom = process.env.PARIO_AUTH_EMAIL_FROM ?? "Acme Corp <onboarding@resend.dev>"

export const pario = createPario({
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".pario" }),
  lakeStorage: new LocalLakeStorage({ path: ".pario/lake" }),
  blobStorage,
  queues: new InMemoryQueues(),
  auth: magicLink({
    allowedDomains: ["acme.com", "sixb.ai"],
    bootstrapUsers: ["daniel@sixb.ai", "anthony@sixb.ai", "quentin@sixb.ai"],
    bootstrapGroups: [securityAdmins],
    publicUrl: process.env.PARIO_PUBLIC_URL,
    async sendMagicLink(message) {
      if (!resend) {
        throw new Error("[AcmeCorp] RESEND_API_KEY is required to send auth emails.")
      }

      const { error } = await resend.emails.send({
        from: message.from ?? authEmailFrom,
        to: message.email,
        subject: message.subject,
        text: message.text,
        html: message.html,
      })

      if (error) {
        throw new Error(`[AcmeCorp] Resend failed to send auth email: ${error.message}`)
      }
    },
  }),
})
