/**
 * End-to-end check against the real Fleetio API.
 *
 * Not part of `bun test`: it needs live credentials. Run it directly:
 *
 *     FLEETIO_API_KEY="…" FLEETIO_ACCOUNT_TOKEN="…" bun connectors/fleetio/tests/fleetio.e2e.ts
 *
 * Reads only. Nothing here creates, updates, or deletes anything; the write surface is covered by
 * the unit tests against mocks.
 */
import { FleetioApiError, fleetio } from "../src"

const apiKey = process.env.FLEETIO_API_KEY
const accountToken = process.env.FLEETIO_ACCOUNT_TOKEN
if (!apiKey || !accountToken) {
  console.log("[fleetio e2e] Skipped: set FLEETIO_API_KEY and FLEETIO_ACCOUNT_TOKEN to run.")
  process.exit(0)
}

const fl = await fleetio({ apiKey, accountToken, timeoutMs: 60_000 }).connect({
  projectId: "e2e",
  connectorId: "fleetio",
  signal: new AbortController().signal,
})

let failures = 0

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }

  failures += 1
  console.log(`  ✗ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
}

/** Plan-gated modules answer 403 or 404, which says nothing about the connector. */
async function optional(label: string, read: () => Promise<unknown>) {
  try {
    await read()
    console.log(`  ✓ ${label}`)
  } catch (error) {
    if (error instanceof FleetioApiError && (error.status === 403 || error.status === 404)) {
      console.log(`  - ${label}: not available on this account (${error.status})`)
      return
    }

    failures += 1
    console.log(`  ✗ ${label} — ${String(error)}`)
  }
}

console.log("\ncredentials and version")
const me = await fl.users.me()
check("users.me resolves the key's user", typeof me.id === "number")

console.log("\nwork orders")
const orders = await fl.workOrders.list({ pageSize: 2, sort: { updated_at: "desc" } })
check("the page envelope is complete", "next_cursor" in orders && Array.isArray(orders.records))
check("per_page honors pageSize", orders.per_page === 2, orders.per_page)

const first = orders.records[0]
if (first) {
  const order = await fl.workOrders.get(first.id)
  check("get returns the record", order.id === first.id)
  check("get includes line items", Array.isArray(order.work_order_line_items))

  await fl.workOrderLineItems.list(first.id)
  console.log("  ✓ line items list")

  const byVehicle = await fl.workOrders.list({
    pageSize: 1,
    filter: { vehicle_id: { eq: first.vehicle_id } },
  })
  check(
    "a nested filter is applied",
    byVehicle.records.every((record) => record.vehicle_id === first.vehicle_id)
  )

  const recent = await fl.workOrders.list({
    pageSize: 1,
    filter: { updated_at: { gte: "2000-01-01T00:00:00Z" } },
  })
  check("a date filter is accepted", recent.records.length > 0)
} else {
  console.log("  - no work orders on this account")
}

if (orders.next_cursor) {
  const second = await fl.workOrders.list({
    pageSize: 2,
    cursor: orders.next_cursor,
    sort: { updated_at: "desc" },
  })
  check(
    "a cursor reaches a different page",
    second.records[0]?.id !== orders.records[0]?.id,
    second.records[0]?.id
  )

  let walked = 0
  for await (const _ of fl.workOrders.listAll({ pageSize: 2 })) {
    walked += 1
    if (walked > 2) {
      break
    }
  }
  check("listAll crosses a page boundary", walked > 2, walked)
}

console.log("\nother resources")
await optional("work order statuses", () => fl.workOrderStatuses.list({ pageSize: 1 }))
await optional("VMRS reasons", () => fl.vmrsReasonsForRepair.list())
await optional("issues", () => fl.issues.list({ pageSize: 1 }))
await optional("service entries", () => fl.serviceEntries.list({ pageSize: 1 }))
await optional("service reminders", () => fl.serviceReminders.list({ pageSize: 1 }))
await optional("service tasks", () => fl.serviceTasks.list({ pageSize: 1 }))
await optional("vehicles", () => fl.vehicles.list({ pageSize: 1 }))
await optional("vehicle search", () => fl.vehicles.search({ pageSize: 1 }))
await optional("contacts", () => fl.contacts.list({ pageSize: 1 }))
await optional("vendors", () => fl.vendors.list({ pageSize: 1 }))
await optional("parts", () => fl.parts.list({ pageSize: 1 }))
await optional("purchase orders", () => fl.purchaseOrders.list({ pageSize: 1 }))
await optional("meter entries", () => fl.meterEntries.list({ pageSize: 1 }))
await optional("fuel entries", () => fl.fuelEntries.list({ pageSize: 1 }))
await optional("expense entries", () => fl.expenseEntries.list({ pageSize: 1 }))
await optional("faults", () => fl.faults.list({ pageSize: 1 }))
await optional("submitted inspection forms", () =>
  fl.submittedInspectionForms.list({ pageSize: 1 })
)
await optional("custom fields", () => fl.customFields.list({ pageSize: 1 }))
await optional("webhooks", () => fl.webhooks.list({ pageSize: 1 }))

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
