import { describe, expect, test } from "bun:test"
import { microsoft } from "../src"

const tenantId = process.env.MICROSOFT_TENANT_ID
const clientId = process.env.MICROSOFT_CLIENT_ID
const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
const mailbox = process.env.MICROSOFT_MAIL_TEST_MAILBOX
const folderId = process.env.MICROSOFT_TEST_MAIL_FOLDER_ID ?? "inbox"
const notificationUrl = process.env.MICROSOFT_TEST_NOTIFICATION_URL
const webhookSecret = process.env.MICROSOFT_WEBHOOK_SECRET
const enabled = Boolean(
  tenantId && clientId && clientSecret && mailbox && notificationUrl && webhookSecret
)

function connect(signal: AbortSignal) {
  if (!tenantId || !clientId || !clientSecret) throw new Error("Missing Microsoft E2E credentials.")
  return microsoft({ auth: { tenantId, clientId, clientSecret }, webhookSecret }).connect({
    projectId: "mail-subscriptions-e2e",
    connectorId: "microsoft",
    signal,
  })
}

describe.skipIf(!enabled)("Microsoft 365 live mail subscriptions", () => {
  test("creates, validates, renews and cleans up a mail subscription", async () => {
    if (!mailbox || !notificationUrl) throw new Error("Missing live subscription configuration.")
    const client = await connect(AbortSignal.timeout(80_000))
    const subscription = await client.mail.subscribe(mailbox, {
      folderId,
      notificationUrl,
      changeTypes: ["created", "updated", "deleted"],
      expirationDateTime: new Date(Date.now() + 86_400_000).toISOString(),
    })
    try {
      expect((await client.subscriptions.get(subscription.id)).id).toBe(subscription.id)
      const renewed = await client.subscriptions.renew(
        subscription.id,
        new Date(Date.now() + 2 * 86_400_000).toISOString()
      )
      expect(Date.parse(renewed.expirationDateTime!)).toBeGreaterThan(
        Date.parse(subscription.expirationDateTime!)
      )
    } finally {
      await (await connect(AbortSignal.timeout(30_000))).subscriptions.delete(subscription.id)
    }
  }, 120_000)
})
