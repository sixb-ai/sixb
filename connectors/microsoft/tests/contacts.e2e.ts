import { describe, expect, test } from "bun:test"
import { type Contact, type ContactsSurface, MicrosoftApiError, microsoft } from "../src"

// Explicit opt-in against a dedicated test mailbox. The test writes uniquely named folders and
// contacts, verifies the paths this connector relies on beyond Graph's examples (the default
// folder found through a contact, nested folders addressed by ID), then removes its own data.
const enabled = process.env.MICROSOFT_CONTACTS_E2E === "1"
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} for the explicitly enabled contacts E2E.`)
  return value
}
async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline) throw new Error("Contact change was not visible within 30 seconds.")
    await Bun.sleep(1000)
  }
}
async function round(
  contacts: ContactsSurface,
  mailbox: string,
  folderId: string,
  cursor?: string
): Promise<{ readonly items: Contact[]; readonly cursor: string }> {
  const items: Contact[] = []
  let next: string | undefined
  for await (const page of contacts.items.delta.pages(mailbox, folderId, {
    ...(cursor ? { cursor } : { select: ["givenName", "displayName"] }),
  })) {
    items.push(...page.value)
    next = page["@odata.deltaLink"] ?? next
  }
  if (!next) throw new Error("Contact delta finished without a deltaLink.")
  return { items, cursor: next }
}

describe.skipIf(!enabled)("Outlook contacts live application access", () => {
  test("default and nested folders, every field, photo, extensions, delta and deletion", async () => {
    const auth = {
      tenantId: required("MICROSOFT_TENANT_ID"),
      clientId: required("MICROSOFT_CLIENT_ID"),
      clientSecret: required("MICROSOFT_CLIENT_SECRET"),
    }
    const mailbox = required("MICROSOFT_CONTACTS_TEST_MAILBOX")
    const denied = required("MICROSOFT_CONTACTS_DENIED_MAILBOX")
    const context = {
      projectId: "contacts-e2e",
      connectorId: "microsoft",
      signal: AbortSignal.timeout(240_000),
    }
    const { contacts } = await microsoft({ auth }).connect(context)
    await expect(contacts.folders.list(denied, { top: 1 })).rejects.toMatchObject({ status: 403 })
    const name = `sixb-contacts-e2e-${crypto.randomUUID()}`
    const address = `${name}@example.com`
    const errors: unknown[] = []
    const ownedDefault: string[] = []
    let parentId: string | undefined
    try {
      // The default folder is only reachable through a contact it holds.
      const seed = await contacts.items.create(mailbox, {
        givenName: name,
        emailAddresses: [{ address, name }],
      })
      ownedDefault.push(seed.id)
      const root = await contacts.folders.getDefault(mailbox)
      expect(root?.id).toBe(seed.parentFolderId!)
      const first = await eventually(
        () => round(contacts, mailbox, root!.id),
        (result) => result.items.some((item) => item.id === seed.id)
      )
      const [match] = await eventually(
        async () => {
          const found: Contact[] = []
          for await (const c of contacts.items.listAll(mailbox, { email: address })) found.push(c)
          return found
        },
        (found) => found.length > 0
      )
      expect(match.id).toBe(seed.id)

      const parent = await contacts.folders.create(mailbox, name)
      parentId = parent.id
      const child = await contacts.folders.create(mailbox, `${name}-child`, { parentId: parent.id })
      const children: string[] = []
      for await (const folder of contacts.folders.listAllChildren(mailbox, parent.id))
        children.push(folder.id)
      expect(children).toContain(child.id)
      expect(
        (await contacts.folders.update(mailbox, child.id, { displayName: `${name}-renamed` }))
          .displayName
      ).toBe(`${name}-renamed`)

      // A nested folder is addressed by its own ID, without the childFolders chain.
      const nested = await contacts.items.create(
        mailbox,
        {
          givenName: "Ada",
          middleName: "King",
          surname: name,
          displayName: `Ada ${name}`,
          birthday: "1990-12-10T00:00:00Z",
          companyName: "Analytical Engines",
          jobTitle: "Programmer",
          department: "Research",
          officeLocation: "1/101",
          businessPhones: ["+1 555 0100"],
          homePhones: ["+1 555 0101"],
          mobilePhone: "+1 555 0102",
          emailAddresses: [{ address: `ada.${address}`, name: "Ada" }],
          imAddresses: ["sip:ada@example.com"],
          businessAddress: { street: "1 Engine Way", city: "London", countryOrRegion: "UK" },
          categories: ["Sixb E2E"],
          children: ["Byron"],
          personalNotes: "Created by the Sixb contacts E2E.",
          singleValueExtendedProperties: [
            { id: "String {66f5a359-4659-4830-9070-00040ec6ac6e} Name sixbE2e", value: name },
          ],
          extensions: [{ extensionName: "Com.Sixb.E2e", run: name, attempt: 1 }],
        },
        { folderId: child.id }
      )
      const read = await contacts.items.get(mailbox, nested.id, {
        folderId: child.id,
        expand:
          "singleValueExtendedProperties($filter=id eq 'String {66f5a359-4659-4830-9070-00040ec6ac6e} Name sixbE2e')",
      })
      expect(read.parentFolderId).toBe(child.id)
      expect(read.mobilePhone).toBe("+1 555 0102")
      expect(read.businessAddress?.city).toBe("London")
      expect(read.singleValueExtendedProperties?.[0]?.value).toBe(name)
      const updated = await contacts.items.update(
        mailbox,
        nested.id,
        { jobTitle: "Lead programmer", displayName: read.displayName },
        { folderId: child.id }
      )
      expect(updated.displayName).toBe(read.displayName!)

      expect(
        (await contacts.extensions.get(mailbox, nested.id, "Com.Sixb.E2e", { folderId: child.id }))
          .run
      ).toBe(name)
      expect(
        (
          await contacts.extensions.update(
            mailbox,
            nested.id,
            { extensionName: "Com.Sixb.E2e", attempt: 2 },
            { folderId: child.id }
          )
        ).attempt
      ).toBe(2)
      await contacts.extensions.delete(mailbox, nested.id, "Com.Sixb.E2e", { folderId: child.id })

      const jpeg = new Uint8Array(
        await Bun.file(`${import.meta.dir}/fixtures/contact-photo.jpg`).arrayBuffer()
      )
      await contacts.photo.upload(mailbox, nested.id, jpeg, { folderId: child.id })
      expect((await contacts.photo.get(mailbox, nested.id, { folderId: child.id })).id).toBeTruthy()
      expect(
        (await contacts.photo.download(mailbox, nested.id, { folderId: child.id })).length
      ).toBeGreaterThan(0)

      // The nested folder's own delta sees its contact; the default folder's next round sees the
      // seed's update and deletion.
      const nestedRound = await eventually(
        () => round(contacts, mailbox, child.id),
        (result) => result.items.some((item) => item.id === nested.id)
      )
      expect(nestedRound.cursor).toBeTruthy()
      await contacts.items.update(mailbox, seed.id, { jobTitle: "Updated" })
      await eventually(
        () => round(contacts, mailbox, root!.id, first.cursor),
        (result) => result.items.some((item) => item.id === seed.id)
      )
      const folders: string[] = []
      for await (const page of contacts.folders.delta.pages(mailbox))
        folders.push(...page.value.map((folder) => folder.id))
      expect(folders).toContain(parent.id)

      await contacts.items.permanentDelete(mailbox, nested.id, { folderId: child.id })
      await contacts.folders.permanentDelete(mailbox, child.id)
      await expect(
        contacts.items.get(mailbox, nested.id, { folderId: child.id })
      ).rejects.toBeInstanceOf(MicrosoftApiError)
    } catch (error) {
      errors.push(error)
    } finally {
      const cleanup = (
        await microsoft({ auth }).connect({ ...context, signal: AbortSignal.timeout(45_000) })
      ).contacts
      for (const id of ownedDefault) {
        try {
          await cleanup.items.permanentDelete(mailbox, id)
        } catch (error) {
          if (!(error instanceof MicrosoftApiError && error.status === 404)) errors.push(error)
        }
      }
      if (parentId) {
        try {
          await cleanup.folders.permanentDelete(mailbox, parentId)
        } catch (error) {
          if (!(error instanceof MicrosoftApiError && error.status === 404)) errors.push(error)
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, `Contacts E2E or cleanup failed (${name}).`)
  }, 290_000)
})
