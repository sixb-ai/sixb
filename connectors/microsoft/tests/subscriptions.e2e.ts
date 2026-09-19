import { describe, expect, test } from "bun:test"
import { microsoft } from "../src"

const enabled = process.env.MICROSOFT_SUBSCRIPTIONS_E2E === "1"
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} for the explicitly enabled subscriptions E2E.`)
  return value
}

// Use a dedicated resource with no existing subscription for this application/changeType.
// The public HTTPS receiver must implement Graph's validation challenge before running this test.
describe.skipIf(!enabled)("Graph subscriptions live application access", () => {
  test("create, read, list, renew and delete a basic subscription", async () => {
    const { subscriptions } = await microsoft({
      auth: {
        tenantId: required("MICROSOFT_TENANT_ID"),
        clientId: required("MICROSOFT_CLIENT_ID"),
        clientSecret: required("MICROSOFT_CLIENT_SECRET"),
      },
    }).connect({
      projectId: "subscriptions-e2e",
      connectorId: "microsoft",
      signal: new AbortController().signal,
    })
    const options = { signal: AbortSignal.timeout(120_000) }
    const created = await subscriptions.create(
      {
        resource: required("MICROSOFT_SUBSCRIPTIONS_TEST_RESOURCE"),
        notificationUrl: required("MICROSOFT_SUBSCRIPTIONS_NOTIFICATION_URL"),
        changeType: "updated",
        expirationDateTime: new Date(Date.now() + 3600_000).toISOString(),
        clientState: crypto.randomUUID(),
      },
      options
    )
    try {
      expect((await subscriptions.get(created.id, options)).id).toBe(created.id)
      const ids: string[] = []
      for await (const item of subscriptions.listAll(options)) ids.push(item.id)
      expect(ids).toContain(created.id)
      const renewed = await subscriptions.update(
        created.id,
        {
          expirationDateTime: new Date(Date.now() + 7200_000).toISOString(),
        },
        options
      )
      expect(Date.parse(renewed.expirationDateTime ?? "")).toBeGreaterThan(
        Date.parse(created.expirationDateTime ?? "")
      )
      // PATCH also reauthorizes. Graph forbids a separate reauthorize within ten minutes.
    } finally {
      // Bound cleanup independently of the earlier operations.
      await subscriptions.delete(created.id, { signal: AbortSignal.timeout(30_000) })
    }
  }, 160_000)
})
