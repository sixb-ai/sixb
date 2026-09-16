import { describe, expect, test } from "bun:test"
import { microsoft } from "../src"

// Explicit opt-in: writes only uniquely named test drafts/folders. Optional sending requires
// MICROSOFT_MAIL_TEST_RECIPIENT, a consenting test address. Never use a production recipient.
const enabled = process.env.MICROSOFT_MAIL_E2E === "1"
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} for the explicitly enabled Microsoft mail E2E.`)
  return value
}
describe.skipIf(!enabled)("Outlook live application access", () => {
  test("scoped mail CRUD, binary attachments, delta and optional sending", async () => {
    const auth = {
      tenantId: required("MICROSOFT_TENANT_ID"),
      clientId: required("MICROSOFT_CLIENT_ID"),
      clientSecret: required("MICROSOFT_CLIENT_SECRET"),
    }
    const mailbox = required("MICROSOFT_MAIL_TEST_MAILBOX")
    const deniedMailbox = required("MICROSOFT_MAIL_DENIED_MAILBOX")
    const context = {
      projectId: "mail-e2e",
      connectorId: "microsoft",
      signal: AbortSignal.timeout(150_000),
    }
    const { mail } = await microsoft({ auth }).connect(context)
    await expect(mail.messages.list(deniedMailbox, { top: 1 })).rejects.toMatchObject({
      status: 403,
    })
    const name = `sixb-mail-e2e-${crypto.randomUUID()}`
    const folder = await mail.folders.create(mailbox, name)
    const drafts = new Set<string>()
    const errors: unknown[] = []
    try {
      const checkpoint = await mail.messages.delta.list(mailbox, folder.id)
      const draft = await mail.messages.createDraft(mailbox, {
        subject: name,
        body: { contentType: "text", content: "Sixb integration test" },
      })
      drafts.add(draft.id)
      expect(draft.isDraft).toBe(true)
      const updated = await mail.messages.updateDraft(mailbox, draft.id, {
        subject: `${name} updated`,
      })
      expect(updated.subject).toBe(`${name} updated`)
      const small = Uint8Array.from([0, 127, 128, 255])
      const attached = await mail.attachments.upload(mailbox, draft.id, "small.bin", small)
      expect(Array.from(await mail.attachments.download(mailbox, draft.id, attached.id))).toEqual(
        Array.from(small)
      )
      await mail.attachments.delete(mailbox, draft.id, attached.id)
      const large = new Uint8Array(4 * 1024 * 1024 + 17)
      large[0] = 41
      large[large.length - 1] = 43
      const big = await mail.attachments.upload(mailbox, draft.id, "large.bin", large)
      expect(Bun.hash(await mail.attachments.download(mailbox, draft.id, big.id))).toBe(
        Bun.hash(large)
      )
      await mail.attachments.delete(mailbox, draft.id, big.id)
      const moved = await mail.messages.move(mailbox, draft.id, folder.id)
      drafts.add(moved.id)
      expect(moved.id).toBe(draft.id)
      expect((await mail.messages.get(mailbox, draft.id)).parentFolderId).toBe(folder.id)
      let cursor = checkpoint["@odata.deltaLink"]
      expect(cursor).toBeDefined()
      let found = false
      const deadline = Date.now() + 30_000
      while (!found && Date.now() < deadline) {
        for await (const page of mail.messages.delta.pages(mailbox, folder.id, { cursor })) {
          found ||= page.value.some((message) => message.id === draft.id && !message["@removed"])
          cursor = page["@odata.deltaLink"] ?? page["@odata.nextLink"]
        }
        if (!found) await Bun.sleep(1000)
      }
      expect(found).toBeTruthy()
      const recipient = process.env.MICROSOFT_MAIL_TEST_RECIPIENT
      if (recipient) {
        const outgoing = await mail.messages.createDraft(mailbox, {
          subject: name,
          body: { contentType: "text", content: "Authorized Sixb mail integration test." },
          toRecipients: [{ emailAddress: { address: recipient } }],
        })
        drafts.add(outgoing.id)
        expect((await mail.messages.send(mailbox, outgoing.id)).status).toBe("accepted")
        // Sent copy is eventually visible. Cleanup deliberately retains an accepted sent message
        // for verification; remove its subject-matched test copy manually after checking delivery.
        drafts.delete(outgoing.id)
      }
    } catch (error) {
      errors.push(error)
    } finally {
      const cleanup = (
        await microsoft({ auth }).connect({ ...context, signal: AbortSignal.timeout(30_000) })
      ).mail
      for (const id of drafts) {
        try {
          await cleanup.messages.delete(mailbox, id)
        } catch (error) {
          errors.push(error)
        }
      }
      try {
        await cleanup.folders.delete(mailbox, folder.id)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "Outlook E2E or cleanup failed.")
  }, 190_000)
})
