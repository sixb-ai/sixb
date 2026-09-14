import { describe, expect, test } from "bun:test"
import { type DeltaPage, microsoft } from "../src"

// Opt-in live test; see README. Uses a unique temporary folder and deletes it in finally.
// Existing tenant data is never modified. Credentials must have write access to this test drive.
const tenantId = process.env.MICROSOFT_TENANT_ID
const clientId = process.env.MICROSOFT_CLIENT_ID
const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
const siteUrl = process.env.MICROSOFT_SITE_URL
const driveId = process.env.MICROSOFT_TEST_DRIVE_ID
const enabled = Boolean(tenantId && clientId && clientSecret && siteUrl && driveId)

describe.skipIf(!enabled)("SharePoint Online live application access", () => {
  test("sites, binary transfers, conflicts, moves, delta and cleanup", async () => {
    if (!tenantId || !clientId || !clientSecret || !siteUrl || !driveId)
      throw new Error("Missing Microsoft E2E configuration.")
    const client = await microsoft({ auth: { tenantId, clientId, clientSecret } }).connect({
      projectId: "microsoft-e2e",
      connectorId: "microsoft",
      signal: AbortSignal.timeout(110_000),
    })
    const site = await client.sites.getByUrl(siteUrl)
    const libraries = []
    for await (const library of client.sites.listAllDrives(site.id)) libraries.push(library)
    expect(libraries.some((library) => library.id === driveId)).toBe(true)
    expect((await client.drives.get(driveId)).id).toBe(driveId)
    const checkpoint = await client.drives.delta.list(driveId, { token: "latest" })
    const folder = await client.drives.items.createFolder(
      driveId,
      process.env.MICROSOFT_TEST_PARENT_ID ?? "root",
      `sixb-e2e-${crypto.randomUUID()}`
    )
    try {
      const target = { parentId: folder.id, name: "Résumé #100%.bin" }
      const binary = Uint8Array.from([0, 1, 127, 128, 255])
      const file = await client.drives.uploads.upload(driveId, target, binary)
      expect(Array.from(await client.drives.items.download(driveId, file.id))).toEqual(
        Array.from(binary)
      )
      await expect(client.drives.uploads.upload(driveId, target, binary)).rejects.toMatchObject({
        status: 409,
      })
      await expect(
        client.drives.items.rename(driveId, file.id, "blocked.bin", {
          ifMatch: '"not-the-current-etag"',
        })
      ).rejects.toMatchObject({ status: 412 })
      const renamed = await client.drives.items.rename(driveId, file.id, "renamed.bin", {
        ifMatch: file.eTag,
      })
      expect(renamed.name).toBe("renamed.bin")
      const nested = await client.drives.items.createFolder(driveId, folder.id, "nested")
      await client.drives.items.move(driveId, file.id, nested.id)
      const children = await client.drives.items.listChildren(driveId, nested.id)
      expect(children.value.some((item) => item.id === file.id)).toBe(true)

      const large = new Uint8Array(10 * 1024 * 1024 + 17)
      large[0] = 42
      large[large.length - 1] = 255
      const uploaded = await client.drives.uploads.upload(
        driveId,
        { parentId: folder.id, name: "large.bin" },
        large
      )
      const downloaded = await client.drives.items.download(driveId, uploaded.id)
      expect(Bun.hash(downloaded)).toBe(Bun.hash(large))
      const empty = await client.drives.uploads.upload(
        driveId,
        { parentId: folder.id, name: "empty.bin" },
        new Uint8Array()
      )
      expect(empty.size).toBe(0)
      await client.drives.items.delete(driveId, uploaded.id)

      // Graph change visibility is eventual. Advance only after processing each page.
      let cursor = checkpoint["@odata.deltaLink"]
      let found = false
      const deadline = Date.now() + 30_000
      while (!found && Date.now() < deadline) {
        for await (const page of client.drives.delta.pages(driveId, { cursor })) {
          found ||= page.value.some((item) => item.id === file.id)
          cursor = nextCursor(page)
        }
        if (!found) await Bun.sleep(1000)
      }
      expect(found).toBeTruthy()
    } finally {
      // A fresh connection leaves time to clean up even if the test deadline aborted the first.
      const cleanup = await microsoft({ auth: { tenantId, clientId, clientSecret } }).connect({
        projectId: "microsoft-e2e",
        connectorId: "cleanup",
        signal: AbortSignal.timeout(30_000),
      })
      await cleanup.drives.items.delete(driveId, folder.id)
    }
  }, 150_000)
})

function nextCursor(page: DeltaPage): string {
  const cursor = page["@odata.deltaLink"] ?? page["@odata.nextLink"]
  if (!cursor) throw new Error("Missing delta checkpoint.")
  return cursor
}
