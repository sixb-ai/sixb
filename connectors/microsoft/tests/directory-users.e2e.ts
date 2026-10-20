import { describe, expect, test } from "bun:test"
import { isMailboxNotEnabled, microsoft, type User } from "../src"

// Explicit opt-in. Read-only: needs User.Read.All, Contacts.Read on MICROSOFT_USERS_MAILBOX, and an
// account without an Exchange Online mailbox (an unlicensed admin or service account, or a guest).
const enabled = process.env.MICROSOFT_USERS_E2E === "1"
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} for the explicitly enabled users E2E.`)
  return value
}

describe.skipIf(!enabled)("directory users live application access", () => {
  test("lists licensed members, pages, reads by ID and UPN, and tells no mailbox apart", async () => {
    const client = await microsoft({
      auth: {
        tenantId: required("MICROSOFT_TENANT_ID"),
        clientId: required("MICROSOFT_CLIENT_ID"),
        clientSecret: required("MICROSOFT_CLIENT_SECRET"),
      },
    }).connect({
      projectId: "users-e2e",
      connectorId: "microsoft",
      signal: AbortSignal.timeout(120_000),
    })
    const { users } = client.directory
    const select = ["userPrincipalName", "mail", "accountEnabled", "userType", "assignedLicenses"]
    const licensed = await users.list({
      filter: "accountEnabled eq true and userType eq 'Member' and assignedLicenses/$count ne 0",
      advancedQuery: true,
      select,
      top: 999,
    })
    expect(typeof licensed["@odata.count"]).toBe("number")
    const [first] = licensed.value
    if (!first?.userPrincipalName) throw new Error("The tenant has no licensed members to read.")
    for (const user of licensed.value) {
      expect(user).toMatchObject({ accountEnabled: true, userType: "Member" })
      expect(user.assignedLicenses?.length).toBeGreaterThan(0)
    }

    // Two users a page, so listAll has to follow nextLinks; three pages are enough to show it.
    const paged: User[] = []
    for await (const user of users.listAll({ select, top: 2 })) {
      paged.push(user)
      if (paged.length === 6) break
    }
    expect(new Set(paged.map((user) => user.id)).size).toBe(paged.length)
    expect(paged.length).toBeGreaterThanOrEqual(Math.min(6, licensed.value.length))

    expect((await users.get(first.id)).userPrincipalName).toBe(first.userPrincipalName)
    expect((await users.get(first.userPrincipalName, { select: ["userType"] })).id).toBe(first.id)
    // Graph answers 400 for `users/$x@…` and 404 for a missing user in the quoted key form.
    const domain = first.userPrincipalName.split("@")[1]
    for (const missing of [
      `$sixb-e2e-${crypto.randomUUID()}`,
      `$o'sixb-e2e-${crypto.randomUUID()}`,
    ])
      await expect(users.get(`${missing}@${domain}`)).rejects.toMatchObject({ status: 404 })

    const failure = (mailbox: string) =>
      client.contacts.folders.list(mailbox, { top: 1 }).then(
        () => undefined,
        (error: unknown) => error
      )
    expect(await failure(required("MICROSOFT_USERS_MAILBOX"))).toBeUndefined()
    expect(isMailboxNotEnabled(await failure(required("MICROSOFT_USERS_NO_MAILBOX")))).toBe(true)
    const missing = await failure(`sixb-e2e-${crypto.randomUUID()}@${domain}`)
    expect(missing).toMatchObject({ status: 404 })
    expect(isMailboxNotEnabled(missing)).toBe(false)
  }, 150_000)
})
