import { afterEach, describe, expect, test } from "bun:test"
import type { CtmClient } from "../src"
import {
  ACCOUNT_ID,
  collect,
  createTestClient,
  empty,
  json,
  page,
  recorder,
  route,
} from "./helpers"

const originalFetch = globalThis.fetch
const ACCOUNT = `/api/v1/accounts/${ACCOUNT_ID}`

afterEach(() => {
  globalThis.fetch = originalFetch
})

type Read = (client: CtmClient) => Promise<unknown>

/** Each list and detail route, the request it sends, and the envelope key its records come in. */
const READS: readonly (readonly [string, Read, string, string])[] = [
  [
    "sms",
    (c) => c.sms.list({ direction: "inbound", startTime: "2026-11-01" }),
    "sms",
    "/sms?start_time=2026-11-01&direction=inbound&page=1",
  ],
  ["sms detail", (c) => c.sms.get("MSG1"), "", "/sms/MSG1"],
  [
    "text opt-outs",
    (c) => c.textOptOuts.list({ agencyWide: true }),
    "opt_out_texts",
    "/opt_out_texts?agency=1&page=1",
  ],
  [
    "tracking numbers",
    (c) => c.trackingNumbers.list({ name: "Ads" }),
    "numbers",
    "/numbers?name=Ads&page=1",
  ],
  ["tracking number", (c) => c.trackingNumbers.get("TPN1"), "", "/numbers/TPN1"],
  ["dial routes", (c) => c.trackingNumbers.dialRoutes("TPN1"), "", "/numbers/TPN1/dial_routes"],
  [
    "receiving numbers",
    (c) => c.receivingNumbers.list(),
    "receiving_numbers",
    "/receiving_numbers?page=1",
  ],
  ["receiving number", (c) => c.receivingNumbers.get("RPN1"), "", "/receiving_numbers/RPN1"],
  ["target numbers", (c) => c.targetNumbers.list(), "target_numbers", "/target_numbers?page=1"],
  [
    "do not call",
    (c) => c.doNotCall.list({ pageSize: 50 }),
    "do_not_calls",
    "/do_not_calls?page=1&per_page=50",
  ],
  [
    "blocked numbers",
    (c) => c.blockedNumbers.list({ agencyWide: true }),
    "blocked_numbers",
    "/calls/blocked_numbers?agency=1",
  ],
  ["sources", (c) => c.sources.list({ name: "Google" }), "sources", "/sources?name=Google&page=1"],
  ["source", (c) => c.sources.get(4), "", "/sources/4"],
  ["queues", (c) => c.queues.list({ name: "Sales" }), "queues", "/queues.json?name=Sales&page=1"],
  ["schedules", (c) => c.schedules.list(), "schedules", "/schedules?page=1"],
  ["voice menus", (c) => c.voiceMenus.list(), "voice_menus", "/voice_menus?page=1"],
  [
    "voice menu items",
    (c) => c.voiceMenus.listItems("VOM1"),
    "voice_menu_items",
    "/voice_menus/VOM1/voice_menu_items?page=1",
  ],
  [
    "voice menu item",
    (c) => c.voiceMenus.getItem("VOM1", "VMI2"),
    "",
    "/voice_menus/VOM1/voice_menu_items/VMI2",
  ],
  ["smart routers", (c) => c.smartRouters.get("COR1"), "", "/conditional_routers/COR1"],
  [
    "geo routers",
    (c) => c.geoRouters.list({ filter: "East" }),
    "geo_routes",
    "/geo_routes?filter=East&page=1",
  ],
  ["triggers", (c) => c.triggers.list(), "triggers", "/triggers?page=1"],
  ["users", (c) => c.users.list({ email: "a@b.c" }), "users", "/users?email=a@b.c&page=1"],
  ["user groups", (c) => c.userGroups.list(), "user_groups", "/user_groups?page=1"],
  ["agents", (c) => c.agents.list(), "agents", "/agents?page=1"],
  ["agent status", (c) => c.agents.phoneStatus("USR1"), "", "/agents/USR1/phone_status"],
  [
    "agents by status",
    (c) => c.agents.byStatus(["lunch", "online"]),
    "",
    "/agents/by_status?status=lunch,online",
  ],
  ["custom fields", (c) => c.customFields.list(), "custom_fields", "/custom_fields?page=1"],
  ["custom panels", (c) => c.customFields.listPanels(), "panels", "/custom_fields/panels"],
  ["custom panel", (c) => c.customFields.getPanel(3), "", "/custom_fields/3/panel"],
  ["form reactors", (c) => c.formReactors.list(), "form_reactors", "/form_reactors?page=1"],
  ["contact lists", (c) => c.contactLists.list(), "contact_lists", "/lists?page=1"],
  ["contacts", (c) => c.contactLists.listContacts("CL1"), "contacts", "/lists/CL1/contacts?page=1"],
  [
    "lookup",
    (c) => c.lookup.list("tag", { search: "vip" }),
    "results",
    "/lookup.json?object_type=tag&search=vip&page=1",
  ],
  ["webhooks", (c) => c.webhooks.list(), "webhooks", "/webhooks?page=1"],
  [
    "change notifications",
    (c) => c.changeNotifications.list(),
    "change_notifications",
    "/change_notifications?page=1",
  ],
]

describe("reads", () => {
  test.each(READS)("%s", async (_name, read, key, path) => {
    const calls = recorder([key ? page(key, [{ id: 1 }]) : json({ id: 1 })])
    const client = await createTestClient()

    const result = await read(client)

    expect(route(calls[0]!)).toBe(`GET ${ACCOUNT}${path}`)
    if (key) {
      expect(result).toMatchObject({ records: [{ id: 1 }] })
    }
  })
})

describe("contact lists", () => {
  test("contains is true on a 204 and false on a 404", async () => {
    const calls = recorder([empty(204), json({ error: "not found" }, { status: 404 })])
    const client = await createTestClient()

    expect(await client.contactLists.contains("CL1", "+14105551212")).toBe(true)
    expect(await client.contactLists.contains("CL1", "+14105551212")).toBe(false)
    expect(route(calls[0]!)).toBe(`GET ${ACCOUNT}/lists/CL1/contains?phone_number=+14105551212`)
  })

  test("contains surfaces any other failure", async () => {
    recorder([json({ error: "nope" }, { status: 403 })])
    const client = await createTestClient()

    const error = await client.contactLists.contains("CL1", "+1").catch((caught) => caught)

    expect(error).toMatchObject({ status: 403 })
  })
})

describe("agent analytics", () => {
  test("events and utilization take a window in epoch seconds", async () => {
    const calls = recorder([
      json({ start_time: 1, end_time: 2, result_end_time: 2, events: [] }),
      json({ start_time: 1, end_time: 2, events: [], users: {}, metrics: {} }),
    ])
    const client = await createTestClient()

    await client.agents.events({ userId: "USR1", startTime: 1_794_400_000, endTime: 1_794_500_000 })
    await client.agents.utilization({ startTime: 1_794_400_000, endTime: 1_794_500_000 })

    expect(calls.map(route)).toEqual([
      `GET ${ACCOUNT}/agents/events.json?user_id=USR1&start_time=1794400000&end_time=1794500000`,
      `GET ${ACCOUNT}/agents/utilization.json?start_time=1794400000&end_time=1794500000`,
    ])
  })

  test("reject a window in milliseconds or backwards", async () => {
    const client = await createTestClient()

    const fraction = await client.agents
      .utilization({ startTime: 1.5, endTime: 2 })
      .catch((caught) => caught)
    const backwards = await client.agents
      .utilization({ startTime: 10, endTime: 5 })
      .catch((caught) => caught)

    expect(String(fraction)).toContain("whole seconds")
    expect(String(backwards)).toContain("endTime must be after startTime")
  })
})

describe("reports", () => {
  test("series always sends with_time and passes CTM's other filters through", async () => {
    const calls = recorder([json({ series: [] })])
    const client = await createTestClient()

    await client.reports.series({
      startDate: "2026-11-01",
      endDate: "2026-11-12",
      by: "source",
      direction: "inbound",
      filters: { talk_time: 30, talk_time_operator: "greater_than" },
    })

    expect(route(calls[0]!)).toBe(
      `GET ${ACCOUNT}/reports/series.json?talk_time=30&talk_time_operator=greater_than` +
        "&start_date=2026-11-01&end_date=2026-11-12&with_time=1&by=source&direction=inbound"
    )
  })

  test("usage logs scope to the account unless agency-wide", async () => {
    const calls = recorder([json({}), json({})])
    const client = await createTestClient()

    await client.reports.usageLogs({ startDate: "2026-11-01", endDate: "2026-11-12" })
    await client.reports.usageLogs({
      startDate: "2026-11-01",
      endDate: "2026-11-12",
      group: "account",
      agencyWide: true,
    })

    expect(calls[0]?.url.searchParams.get("account")).toBe("1")
    expect(calls[1]?.url.searchParams.has("account")).toBe(false)
    expect(calls[1]?.url.searchParams.get("group")).toBe("account")
  })

  test("dates must be written YYYY-MM-DD", async () => {
    const client = await createTestClient()

    const error = await client.reports
      .series({ startDate: "11/01/2026", endDate: "2026-11-12", by: "source" })
      .catch((caught) => caught)

    expect(String(error)).toContain("startDate must be a date written YYYY-MM-DD")
  })
})

describe("webhook configuration", () => {
  test("create, update and delete a webhook", async () => {
    const webhook = { id: 7, account_id: ACCOUNT_ID, weburl: "https://app.example/hook" }
    const calls = recorder([
      json({ status: "true", webhook, warnings: {} }),
      json({ status: "success" }),
      json({ status: "success" }),
    ])
    const client = await createTestClient()

    const created = await client.webhooks.create({
      weburl: "https://app.example/hook?trigger=end",
      position: "end",
      hooktype: "call",
      username: "ctm",
      password: "pw",
    })
    await client.webhooks.update(7, { weburl: "https://app.example/hook", position: "update" })
    await client.webhooks.delete(7)

    expect(created.webhook.id).toBe(7)
    expect(calls[0]?.body).toMatchObject({ position: "end", hooktype: "call", username: "ctm" })
    expect(calls.map(route)).toEqual([
      `POST ${ACCOUNT}/webhooks`,
      `PUT ${ACCOUNT}/webhooks/7`,
      `DELETE ${ACCOUNT}/webhooks/7`,
    ])
  })

  test("change notifications are wrapped and delivered by webhook", async () => {
    const calls = recorder([
      json({ action: "updated", id: 5, status: "success" }),
      json({ action: "deleted", id: 5, status: "success" }),
    ])
    const client = await createTestClient()

    await client.changeNotifications.create({
      name: "numbers",
      deliver_to: "https://app.example/changes",
      included_data: ["VirtualPhoneNumber"],
    })
    await client.changeNotifications.delete(5)

    expect(calls[0]?.body).toEqual({
      change_notification: {
        name: "numbers",
        deliver_to: "https://app.example/changes",
        included_data: ["VirtualPhoneNumber"],
        delivery_type: "webhook",
      },
    })
    expect(route(calls[1]!)).toBe(`DELETE ${ACCOUNT}/change_notifications/5`)

    const none = await client.changeNotifications
      .create({ name: "x", deliver_to: "https://a.b", included_data: [] })
      .catch((caught) => caught)
    expect(String(none)).toContain("included_data")
  })
})

describe("full listings", () => {
  test("a nested listAll walks every page of its parent", async () => {
    const calls = recorder([
      page("contacts", [{ id: 1 }], { page: 1, total_pages: 2 }),
      page("contacts", [{ id: 2 }], { page: 2, total_pages: 2 }),
    ])
    const client = await createTestClient()

    const contacts = await collect(client.contactLists.listAllContacts("CL1"))

    expect(contacts).toEqual([{ id: 1 }, { id: 2 }])
    expect(calls.map(route)).toEqual([
      `GET ${ACCOUNT}/lists/CL1/contacts?page=1&per_page=100`,
      `GET ${ACCOUNT}/lists/CL1/contacts?page=2&per_page=100`,
    ])
  })
})
