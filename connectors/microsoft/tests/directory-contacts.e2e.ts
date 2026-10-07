import { describe, expect, test } from "bun:test"
import { microsoft, type OrgContact } from "../src"

// Explicit opt-in. Read-only: organizational contacts cannot be written through Graph, so the test
// needs a tenant that already has at least one (Microsoft 365 admin center → Contacts).
const enabled = process.env.MICROSOFT_DIRECTORY_E2E === "1"
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} for the explicitly enabled directory E2E.`)
  return value
}

describe.skipIf(!enabled)("organizational contacts live application access", () => {
  test("lists, counts, reads, follows memberships and starts delta", async () => {
    const { directory } = await microsoft({
      auth: {
        tenantId: required("MICROSOFT_TENANT_ID"),
        clientId: required("MICROSOFT_CLIENT_ID"),
        clientSecret: required("MICROSOFT_CLIENT_SECRET"),
      },
    }).connect({
      projectId: "directory-e2e",
      connectorId: "microsoft",
      signal: AbortSignal.timeout(120_000),
    })
    const counted = await directory.contacts.list({ advancedQuery: true, top: 5 })
    expect(typeof counted["@odata.count"]).toBe("number")
    const [first] = counted.value
    if (!first) throw new Error("The tenant has no organizational contacts to read.")
    const contact: OrgContact = await directory.contacts.get(first.id)
    expect(contact.id).toBe(first.id)
    if (contact.displayName) {
      const token = contact.displayName.split(/\s+/)[0].replaceAll('"', "")
      const found = await directory.contacts.list({ search: `"displayName:${token}"` })
      expect(found.value.some((item) => item.id === first.id)).toBe(true)
    }
    for await (const group of directory.contacts.listAllMemberOf(first.id))
      expect(group["@odata.type"]).toBeTruthy()

    const latest = await directory.contacts.delta.list({ latest: true })
    expect(latest.value).toEqual([])
    expect(latest["@odata.deltaLink"]).toBeTruthy()
    const tracked: string[] = []
    let checkpoint: string | undefined
    for await (const page of directory.contacts.delta.pages({
      select: ["displayName", "mail"],
      ids: [first.id],
    })) {
      tracked.push(...page.value.map((item) => item.id))
      checkpoint = page["@odata.deltaLink"] ?? checkpoint
    }
    // Graph can replay an object within a round; the ID filter still admits only this contact.
    expect(tracked.length > 0 && tracked.every((id) => id === first.id)).toBe(true)
    expect(checkpoint).toBeTruthy()
  }, 150_000)
})
