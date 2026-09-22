# Testing

Test your project with Bun and Sixb's in-memory providers. `createTestSixb` gives tests the same typed data API used inside your handlers, with optional permissions for a specific caller.

## Create a fixture

Register the definitions your test needs and give each test fresh providers. This fixture uses your project's `Invoice` type, with `id` and `status` properties, and a read-only finance role. The query below assumes `status` has `query.searchable` and `query.filterable` enabled; see [Property query metadata](../ontology/properties.md#enable-queries).

```ts
// tests/fixture.ts
import {
  can,
  defineGroup,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { Invoice } from "../ontology/invoice"

export const financeTeam = defineGroup("finance-team")
const invoiceReader = defineRole("invoice-reader", {
  grantedTo: [financeTeam],
  grants: [can.view(Invoice)],
})

export function createFixture() {
  const host = new SixbHost({
    id: "invoice-test",
    ontology: [Invoice],
    groups: [financeTeam],
    roles: [invoiceReader],
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
  })

  return { host, sixb: createTestSixb(host) }
}
```

Include linked types and other definitions your tests use. Without an authorization context, the test SDK has unrestricted access. Use it to seed data; bind a caller below when testing permissions.

## Test application behavior

Seed representative data, call your query or application code, and assert the result:

```ts
// tests/invoices.test.ts
import { expect, test } from "bun:test"
import { Invoice } from "../ontology/invoice"
import { createFixture } from "./fixture"

test("paid invoices are excluded from the outstanding list", async () => {
  const { sixb } = createFixture()
  await sixb.objects(Invoice).upsert({ properties: { id: "inv-1", status: "open" } })
  await sixb.objects(Invoice).upsert({ properties: { id: "inv-2", status: "paid" } })

  const result = await sixb.objects(Invoice)
    .query()
    .where((invoice) => invoice.p.status.eq("open"))
    .list()

  expect(result.objects.map((invoice) => invoice.primaryId)).toEqual(["inv-1"])
})
```

Run your tests with:

```bash
bun test tests/
```

## Test permissions

Create a caller from the fixture's registered roles. Check both the operation they may perform and one they must not:

```ts
// tests/permissions.test.ts
import { expect, test } from "bun:test"
import { resolveAuthorizationContext } from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { Invoice } from "../ontology/invoice"
import { createFixture, financeTeam } from "./fixture"

test("finance readers can view invoices but cannot change them", async () => {
  const { host, sixb } = createFixture()
  await sixb.objects(Invoice).upsert({ properties: { id: "inv-1", status: "open" } })

  const authorization = resolveAuthorizationContext({
    principal: { type: "user", id: "reader-1" },
    groupIds: [financeTeam.id],
    roles: host.definitions.security.listResolvedRoles(),
  })
  const reader = createTestSixb(host, { authorization })

  expect(await reader.objects(Invoice).byId("inv-1").get()).not.toBeNull()
  await expect(
    reader.objects(Invoice).upsert({ properties: { id: "inv-1", status: "paid" } })
  ).rejects.toThrow()
})
```

Use your actual security definitions when testing your project's access rules. See [Roles & permissions](../auth/authorization.md).

## Integration tests

Use real providers or a running development instance when testing database behavior, external integrations, or complete action and workflow execution. Creating a test SDK does not start workers; requesting an action queues it rather than executing its handler.

Keep integration tests isolated from production data and credentials. Test your app's user journeys through its UI or the [Client SDK](../client/overview.md).
