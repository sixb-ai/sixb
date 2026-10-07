import { afterEach, expect, test } from "bun:test"
import {
  type ContactDeltaOptions,
  MicrosoftApiError,
  MicrosoftConfigurationError,
  MicrosoftContactMutationError,
  MicrosoftProtocolError,
} from "../src"
import { apiError, collect, connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)
const mailbox = "user+test@example.com"
const base = `${GRAPH}users/user%2Btest%40example.com`
const immutable = 'IdType="ImmutableId"'
const pathOf = (url: string) => new URL(url).pathname
const body = (init: RequestInit) => JSON.parse(String(init.body))

test("contacts default to the Contacts folder and route by folderId with immutable IDs", async () => {
  const requests = mockFetch((r) =>
    r.method === "DELETE" || r.url.endsWith("/permanentDelete")
      ? new Response(null, { status: 204 })
      : json(
          r.method === "GET" && !r.url.includes("/c%2F1") ? { value: [{ id: "c" }] } : { id: "c" }
        )
  )
  const { items } = (await connect()).contacts
  expect((await items.list(mailbox, { top: 5 })).value).toEqual([{ id: "c" }])
  await items.list(mailbox, { folderId: "f/1" })
  await items.get(mailbox, "c/1", { folderId: "f/1", select: ["displayName"], expand: "photo" })
  await items.create(mailbox, { givenName: "Ada" })
  await items.create(mailbox, { givenName: "Ada" }, { folderId: "f/1" })
  await items.update(mailbox, "c/1", { jobTitle: "CTO" })
  await items.delete(mailbox, "c/1", { folderId: "f/1" })
  await items.permanentDelete(mailbox, "c/1")
  await items.permanentDelete(mailbox, "c/1", { folderId: "f/1" })
  expect(requests.map((r) => [r.method, pathOf(r.url)])).toEqual([
    ["GET", pathOf(`${base}/contacts`)],
    ["GET", pathOf(`${base}/contactFolders/f%2F1/contacts`)],
    ["GET", pathOf(`${base}/contactFolders/f%2F1/contacts/c%2F1`)],
    ["POST", pathOf(`${base}/contacts`)],
    ["POST", pathOf(`${base}/contactFolders/f%2F1/contacts`)],
    ["PATCH", pathOf(`${base}/contacts/c%2F1`)],
    ["DELETE", pathOf(`${base}/contactFolders/f%2F1/contacts/c%2F1`)],
    ["POST", pathOf(`${base}/contacts/c%2F1/permanentDelete`)],
    ["POST", pathOf(`${base}/contactFolders/f%2F1/contacts/c%2F1/permanentDelete`)],
  ])
  expect(requests.every((r) => r.headers.get("prefer") === immutable)).toBe(true)
  expect(new URL(requests[0].url).searchParams.get("$top")).toBe("5")
  const get = new URL(requests[2].url).searchParams
  expect([get.get("$select"), get.get("$expand")]).toEqual(["id,displayName", "photo"])
  expect(body(requests[5].init)).toEqual({ jobTitle: "CTO" })
})

test("email lookup uses Graph's only supported contact email filter, escaped", async () => {
  const requests = mockFetch(() => json({ value: [] }))
  const { items } = (await connect()).contacts
  await items.list(mailbox, { email: "o'brien@example.com" })
  expect(new URL(requests[0].url).searchParams.get("$filter")).toBe(
    "emailAddresses/any(a:a/address eq 'o''brien@example.com')"
  )
  await items.list(mailbox, { filter: "startswith(displayName,'A')", orderBy: "displayName" })
  expect(new URL(requests[1].url).searchParams.get("$orderby")).toBe("displayName")
  await expect(items.list(mailbox, { email: "a@b.c", filter: "x" })).rejects.toBeInstanceOf(
    MicrosoftConfigurationError
  )
  expect(requests).toHaveLength(2)
})

test("create sends every field and tags open extensions with their OData type", async () => {
  const requests = mockFetch(() => json({ id: "c" }, 201))
  const { items } = (await connect()).contacts
  const input = {
    givenName: "Ada",
    surname: "Lovelace",
    birthday: "1815-12-10",
    emailAddresses: [{ address: "ada@example.com", name: "Ada Lovelace" }],
    primaryEmailAddress: { address: "ada@example.com" },
    businessPhones: ["+1 555 0100"],
    homeAddress: { street: "1 Engine Way", city: "London", countryOrRegion: "UK" },
    singleValueExtendedProperties: [
      { id: "String {66f5a359-4659-4830-9070-00040ec6ac6e} Name crmId", value: "42" },
    ],
    multiValueExtendedProperties: [
      { id: "StringArray {66f5a359-4659-4830-9070-00040ec6ac6e} Name tags", value: ["a"] },
    ],
    extensions: [{ extensionName: "Com.Contoso.Crm", accountId: 42, active: true }],
  }
  await items.create(mailbox, input)
  expect(body(requests[0].init)).toEqual({
    ...input,
    extensions: [
      {
        "@odata.type": "microsoft.graph.openTypeExtension",
        extensionName: "Com.Contoso.Crm",
        accountId: 42,
        active: true,
      },
    ],
  })
})

test("invalid contact input fails before HTTP", async () => {
  const requests = mockFetch(() => json({ id: "c" }))
  const { items, folders } = (await connect()).contacts
  for (const input of [
    { emailAddresses: [{ address: " " }] },
    { primaryEmailAddress: { name: "No address" } },
    { birthday: "not a date" },
    { singleValueExtendedProperties: [{ id: "", value: "x" }] },
    { extensions: [{ extensionName: "" }] },
  ])
    await expect(items.create(mailbox, input)).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  await expect(
    folders.update(mailbox, "f", { singleValueExtendedProperties: [{ id: " ", value: "x" }] })
  ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  await expect(folders.update(mailbox, "f", {})).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  await expect(items.get(mailbox, "..")).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  expect(requests).toHaveLength(0)
})

// Countercheck: drop the headers argument from listAll's allPages call; page two loses the ID format.
test("listAll keeps immutable IDs on continuation pages", async () => {
  const next = `${base}/contacts?$skiptoken=opaque%2B`
  const requests = mockFetch((r) =>
    r.url === next
      ? json({ value: [{ id: "b" }] })
      : json({ value: [{ id: "a" }], "@odata.nextLink": next })
  )
  const contacts = await collect((await connect()).contacts.items.listAll(mailbox))
  expect(contacts.map((c) => c.id)).toEqual(["a", "b"])
  expect(requests[1].url).toBe(next)
  expect(requests.map((r) => r.headers.get("prefer"))).toEqual([immutable, immutable])
})

test("folders: top level, children, create, update, delete and permanent delete", async () => {
  const requests = mockFetch((r) =>
    r.method === "DELETE" || r.url.endsWith("/permanentDelete")
      ? new Response(null, { status: 204 })
      : json(
          r.url.includes("childFolders") && r.method === "GET"
            ? { value: [] }
            : { id: "f", value: [] }
        )
  )
  const { folders } = (await connect()).contacts
  await folders.list(mailbox)
  await folders.listChildren(mailbox, "p/1")
  await folders.get(mailbox, "f/1", { select: ["displayName"] })
  await folders.create(mailbox, "Partners")
  await folders.create(mailbox, "Family", {
    parentId: "p/1",
    singleValueExtendedProperties: [
      { id: "String {66f5a359-4659-4830-9070-00040ec6ac6e} Name k", value: "v" },
    ],
  })
  await folders.update(mailbox, "f/1", { displayName: "Renamed", parentFolderId: "p/1" })
  await folders.delete(mailbox, "f/1")
  await folders.permanentDelete(mailbox, "f/1")
  expect(requests.map((r) => [r.method, pathOf(r.url)])).toEqual([
    ["GET", pathOf(`${base}/contactFolders`)],
    ["GET", pathOf(`${base}/contactFolders/p%2F1/childFolders`)],
    ["GET", pathOf(`${base}/contactFolders/f%2F1`)],
    ["POST", pathOf(`${base}/contactFolders`)],
    ["POST", pathOf(`${base}/contactFolders/p%2F1/childFolders`)],
    ["PATCH", pathOf(`${base}/contactFolders/f%2F1`)],
    ["DELETE", pathOf(`${base}/contactFolders/f%2F1`)],
    ["POST", pathOf(`${base}/contactFolders/f%2F1/permanentDelete`)],
  ])
  expect(body(requests[3].init)).toEqual({ displayName: "Partners" })
  expect(body(requests[4].init)).toEqual({
    displayName: "Family",
    singleValueExtendedProperties: [
      { id: "String {66f5a359-4659-4830-9070-00040ec6ac6e} Name k", value: "v" },
    ],
  })
  expect(body(requests[5].init)).toEqual({ displayName: "Renamed", parentFolderId: "p/1" })
})

test("getDefault finds the default folder through a contact, and is null while it is empty", async () => {
  const requests = mockFetch((r) =>
    r.url.includes("/contacts?")
      ? json({ value: [{ id: "c", parentFolderId: "default/id" }] })
      : json({ id: "default/id", displayName: "Contacts" })
  )
  const { folders } = (await connect()).contacts
  expect(await folders.getDefault(mailbox)).toEqual({ id: "default/id", displayName: "Contacts" })
  const probe = new URL(requests[0].url)
  expect(probe.pathname).toBe(pathOf(`${base}/contacts`))
  expect([probe.searchParams.get("$select"), probe.searchParams.get("$top")]).toEqual([
    "id,parentFolderId",
    "1",
  ])
  expect(pathOf(requests[1].url)).toBe(pathOf(`${base}/contactFolders/default%2Fid`))
  const empty = mockFetch(() => json({ value: [] }))
  expect(await folders.getDefault(mailbox)).toBeNull()
  expect(empty).toHaveLength(1)
})

// Countercheck: return when result.value is empty in pages(); the checkpoint page is lost.
test("contact delta is per folder, follows opaque cursors and keeps its preferences", async () => {
  const next = `${base}/contactFolders/f/contacts/delta?$skiptoken=opaque%2B%2F%3D`
  const delta = `${base}/contactFolders/f/contacts/delta?$deltatoken=checkpoint%2B%2F%3D`
  const requests = mockFetch((r) =>
    r.url === next
      ? json({
          value: [{ id: "gone", "@removed": { reason: "deleted" } }],
          "@odata.deltaLink": delta,
        })
      : json({ value: [], "@odata.nextLink": next })
  )
  const { items, folders } = (await connect()).contacts
  const pages = await collect(
    items.delta.pages(mailbox, "f", { select: ["displayName"], pageSize: 2 })
  )
  expect(pages).toHaveLength(2)
  expect(pages[1].value).toEqual([{ id: "gone", "@removed": { reason: "deleted" } }])
  expect(pages[1]["@odata.deltaLink"]).toBe(delta)
  const first = new URL(requests[0].url)
  expect(first.pathname).toBe(pathOf(`${base}/contactFolders/f/contacts/delta`))
  expect(first.searchParams.get("$select")).toBe("id,displayName")
  expect(requests[1].url).toBe(next)
  expect(
    requests.every((r) => r.headers.get("prefer") === `${immutable}, odata.maxpagesize=2`)
  ).toBe(true)
  await collect(folders.delta.pages(mailbox))
  expect(pathOf(requests[2].url)).toBe(pathOf(`${base}/contactFolders/delta`))
})

test("delta rejects options Graph does not document, hostile cursors, bad pages and cycles", async () => {
  const requests = mockFetch(() => json({ value: [] }))
  const { items } = (await connect()).contacts
  for (const options of [
    { top: 5 },
    { filter: "x" },
    { cursor: `${base}/contactFolders/f/contacts/delta?$deltatoken=x`, select: ["givenName"] },
  ])
    await expect(
      items.delta.list(mailbox, "f", options as ContactDeltaOptions)
    ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  await expect(
    items.delta.list(mailbox, "f", { cursor: "https://evil.example/steal" })
  ).rejects.toBeInstanceOf(MicrosoftProtocolError)
  expect(requests).toHaveLength(0)
  await expect(items.delta.list(mailbox, "f")).rejects.toBeInstanceOf(MicrosoftProtocolError)
  const loop = `${base}/contactFolders/f/contacts/delta?$skiptoken=loop`
  mockFetch(() => json({ value: [], "@odata.nextLink": loop, "@odata.deltaLink": loop }))
  await expect(items.delta.list(mailbox, "f")).rejects.toBeInstanceOf(MicrosoftProtocolError)
  mockFetch(() => json({ value: [], "@odata.nextLink": loop }))
  await expect(collect(items.delta.pages(mailbox, "f", { cursor: loop }))).rejects.toBeInstanceOf(
    MicrosoftProtocolError
  )
  mockFetch(() => apiError(410, "SyncStateNotFound"))
  await expect(items.delta.list(mailbox, "f", { cursor: loop })).rejects.toMatchObject({
    status: 410,
  })
})

// Countercheck: rethrow `cause` in contacts/common.ts mutation(); interrupted writes stop reporting
// outcomeUnknown. Removing http.ts's GET-only retryable gate makes the 503 case replay.
test("contact mutations never replay, and transport interruptions expose uncertainty", async () => {
  const { contacts } = await connect({
    retry: { maxRetries: 2, delayMs: () => 0, shouldRetry: () => true },
  })
  const requests = mockFetch(() => apiError(503, "ServiceUnavailable"))
  await expect(contacts.items.create(mailbox, { givenName: "A" })).rejects.toMatchObject({
    status: 503,
  })
  expect(requests).toHaveLength(1)
  const lost = mockFetch(() => {
    throw new TypeError("connection lost")
  })
  for (const call of [
    () => contacts.items.create(mailbox, { givenName: "A" }),
    () => contacts.items.update(mailbox, "c", { givenName: "B" }),
    () => contacts.items.delete(mailbox, "c"),
    () => contacts.items.permanentDelete(mailbox, "c"),
    () => contacts.folders.create(mailbox, "F"),
    () => contacts.folders.update(mailbox, "f", { displayName: "G" }),
    () => contacts.folders.delete(mailbox, "f"),
    () => contacts.folders.permanentDelete(mailbox, "f"),
    () => contacts.photo.upload(mailbox, "c", new Uint8Array([1])),
    () => contacts.extensions.create(mailbox, "c", { extensionName: "Com.Contoso.X" }),
    () => contacts.extensions.update(mailbox, "c", { extensionName: "Com.Contoso.X", n: 1 }),
    () => contacts.extensions.delete(mailbox, "c", "Com.Contoso.X"),
  ])
    await expect(call()).rejects.toBeInstanceOf(MicrosoftContactMutationError)
  expect(lost).toHaveLength(12)
})

test("photo metadata, bytes and a single JPEG upload within Graph's 4 MB limit", async () => {
  const requests = mockFetch((r) =>
    r.method === "PUT"
      ? new Response(null, { status: 200 })
      : r.url.endsWith("$value")
        ? new Response(new Uint8Array([7, 8]), { headers: { "Content-Type": "image/jpeg" } })
        : json({ id: "240x240", width: 240, height: 240 })
  )
  const { photo } = (await connect()).contacts
  expect((await photo.get(mailbox, "c/1")).width).toBe(240)
  expect(await photo.download(mailbox, "c/1", { folderId: "f" })).toEqual(new Uint8Array([7, 8]))
  await photo.upload(mailbox, "c/1", new Blob([new Uint8Array([1, 2, 3])]))
  expect(requests.map((r) => [r.method, pathOf(r.url)])).toEqual([
    ["GET", pathOf(`${base}/contacts/c%2F1/photo`)],
    ["GET", `${pathOf(`${base}/contactFolders/f/contacts/c%2F1/photo`)}/$value`],
    ["PUT", `${pathOf(`${base}/contacts/c%2F1/photo`)}/$value`],
  ])
  expect(requests[2].headers.get("content-type")).toBe("image/jpeg")
  expect(new Uint8Array(await (requests[2].init.body as Blob).arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3])
  )
  for (const content of [new Uint8Array(0), new Uint8Array(4 * 1024 * 1024 + 1)])
    await expect(photo.upload(mailbox, "c", content)).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
  expect(requests).toHaveLength(3)
  mockFetch(() => apiError(404, "ErrorItemNotFound"))
  await expect(photo.download(mailbox, "c")).rejects.toBeInstanceOf(MicrosoftApiError)
})

test("open extensions use Graph's documented OData types for create and merge-update", async () => {
  const requests = mockFetch((r) =>
    r.method === "DELETE"
      ? new Response(null, { status: 204 })
      : json({ id: "Microsoft.OutlookServices.OpenTypeExtension.Com.Contoso.Crm" }, 201)
  )
  const { extensions } = (await connect()).contacts
  await extensions.create(mailbox, "c/1", { extensionName: "Com.Contoso.Crm", accountId: 42 })
  await extensions.get(mailbox, "c/1", "Com.Contoso.Crm")
  await extensions.update(mailbox, "c/1", { extensionName: "Com.Contoso.Crm", accountId: 43 })
  await extensions.delete(mailbox, "c/1", "Com.Contoso.Crm", { folderId: "f" })
  expect(requests.map((r) => [r.method, pathOf(r.url)])).toEqual([
    ["POST", pathOf(`${base}/contacts/c%2F1/extensions`)],
    ["GET", pathOf(`${base}/contacts/c%2F1/extensions/Com.Contoso.Crm`)],
    ["PATCH", pathOf(`${base}/contacts/c%2F1/extensions/Com.Contoso.Crm`)],
    ["DELETE", pathOf(`${base}/contactFolders/f/contacts/c%2F1/extensions/Com.Contoso.Crm`)],
  ])
  expect(body(requests[0].init)).toEqual({
    "@odata.type": "microsoft.graph.openTypeExtension",
    extensionName: "Com.Contoso.Crm",
    accountId: 42,
  })
  expect(body(requests[2].init)["@odata.type"]).toBe("#microsoft.graph.openTypeExtension")
})

test("subscribe watches the whole mailbox's contacts with immutable IDs and clientState", async () => {
  const requests = mockFetch(() => json({ id: "s" }, 201))
  const expirationDateTime = new Date(Date.now() + 3 * 86_400_000).toISOString()
  const options = {
    changeTypes: ["created", "updated", "deleted"] as const,
    notificationUrl: "https://app.example/api/webhooks/microsoft/events",
    expirationDateTime,
  }
  const { contacts } = await connect({ webhookSecret: "secret" })
  expect((await contacts.subscribe("ops@contoso.com", options)).id).toBe("s")
  expect(body(requests[0].init)).toMatchObject({
    resource: "users/ops%40contoso.com/contacts",
    changeType: "created,updated,deleted",
    clientState: "secret",
    lifecycleNotificationUrl: options.notificationUrl,
    includeResourceData: false,
  })
  expect(requests[0].headers.get("prefer")).toBe(immutable)
  await expect((await connect()).contacts.subscribe("u", options)).rejects.toThrow("webhookSecret")
  await expect(
    contacts.subscribe("u", {
      ...options,
      expirationDateTime: new Date(Date.now() + 8 * 86_400_000).toISOString(),
    })
  ).rejects.toThrow("seven days")
  await expect(
    contacts.subscribe("u", { ...options, folderId: "f" } as typeof options)
  ).rejects.toThrow("folderId")
  expect(requests).toHaveLength(1)
})
