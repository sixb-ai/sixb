import { afterEach, expect, test } from "bun:test"
import {
  type DirectorySelectOptions,
  MicrosoftConfigurationError,
  MicrosoftProtocolError,
  type OrgContactDeltaOptions,
} from "../src"
import { apiError, collect, connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)
const params = (url: string) => new URL(url).searchParams
const pathOf = (url: string) => new URL(url).pathname

test("organizational contacts list tenant-wide without per-mailbox paths or Outlook headers", async () => {
  const requests = mockFetch(() => json({ value: [{ id: "oc", displayName: "Acme" }] }))
  const { directory } = await connect()
  const result = await directory.contacts.list({ select: ["displayName", "mail"], top: 10 })
  expect(result.value).toEqual([{ id: "oc", displayName: "Acme" }])
  expect(pathOf(requests[0].url)).toBe(pathOf(`${GRAPH}contacts`))
  expect(params(requests[0].url).get("$select")).toBe("id,displayName,mail")
  expect(params(requests[0].url).get("$top")).toBe("10")
  expect(requests[0].headers.get("consistencylevel")).toBeNull()
  expect(requests[0].headers.get("prefer")).toBeNull()
})

// Countercheck: drop request.headers from listAll's allPages call; page two loses eventual consistency.
test("search and advanced queries send ConsistencyLevel on every page and keep @odata.count", async () => {
  const next = `${GRAPH}contacts?$skiptoken=opaque`
  const requests = mockFetch((r) =>
    r.url === next
      ? json({ value: [{ id: "b" }] })
      : json({ value: [{ id: "a" }], "@odata.count": 2, "@odata.nextLink": next })
  )
  const { contacts } = (await connect()).directory
  const searched = await contacts.list({ search: '"displayName:acme"' })
  expect(params(requests[0].url).get("$search")).toBe('"displayName:acme"')
  expect(params(requests[0].url).has("$count")).toBe(false)
  expect(requests[0].headers.get("consistencylevel")).toBe("eventual")
  expect(searched["@odata.count"]).toBe(2)
  const all = await collect(
    contacts.listAll({
      filter: "startsWith(companyName,'Acme')",
      orderBy: "displayName",
      advancedQuery: true,
    })
  )
  expect(all.map((c) => c.id)).toEqual(["a", "b"])
  expect(params(requests[1].url).get("$count")).toBe("true")
  expect(params(requests[1].url).get("$filter")).toBe("startsWith(companyName,'Acme')")
  for (const options of [{ search: '"displayName:a"' }, { advancedQuery: true }])
    await expect(contacts.list({ ...options, expand: "manager" })).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
  expect(requests).toHaveLength(3)
  expect(requests[2].url).toBe(next)
  expect(requests.slice(1).map((r) => r.headers.get("consistencylevel"))).toEqual([
    "eventual",
    "eventual",
  ])
})

test("get, manager and direct reports accept only the options Graph documents", async () => {
  const requests = mockFetch((r) =>
    r.url.includes("directReports")
      ? json({ value: [{ id: "u", "@odata.type": "#microsoft.graph.user" }] })
      : json({ id: "x", "@odata.type": "#microsoft.graph.user" })
  )
  const { contacts } = (await connect()).directory
  await contacts.get("oc/1", { select: ["displayName"], expand: "manager" })
  await contacts.getManager("oc/1", { select: ["displayName"] })
  expect((await contacts.listDirectReports("oc/1")).value[0]["@odata.type"]).toBe(
    "#microsoft.graph.user"
  )
  expect(requests.map((r) => pathOf(r.url))).toEqual([
    pathOf(`${GRAPH}contacts/oc%2F1`),
    pathOf(`${GRAPH}contacts/oc%2F1/manager`),
    pathOf(`${GRAPH}contacts/oc%2F1/directReports`),
  ])
  expect(params(requests[0].url).get("$expand")).toBe("manager")
  for (const options of [{ top: 5 }, { expand: "x" }, { filter: "x" }])
    await expect(
      contacts.listDirectReports("oc", options as DirectorySelectOptions)
    ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  expect(requests).toHaveLength(3)
  mockFetch(() => apiError(404, "Request_ResourceNotFound"))
  await expect(contacts.getManager("oc")).rejects.toMatchObject({ status: 404 })
})

test("group memberships switch to advanced queries only when options are given", async () => {
  const requests = mockFetch(() =>
    json({ value: [{ id: "g", "@odata.type": "#microsoft.graph.group" }] })
  )
  const { contacts } = (await connect()).directory
  await contacts.listMemberOf("oc")
  await contacts.listMemberOf("oc", { search: '"displayName:sales"', top: 5 })
  await collect(contacts.listAllTransitiveMemberOf("oc", { filter: "startswith(displayName,'S')" }))
  expect(requests.map((r) => pathOf(r.url))).toEqual([
    pathOf(`${GRAPH}contacts/oc/memberOf`),
    pathOf(`${GRAPH}contacts/oc/memberOf`),
    pathOf(`${GRAPH}contacts/oc/transitiveMemberOf`),
  ])
  expect(requests.map((r) => r.headers.get("consistencylevel"))).toEqual([
    null,
    "eventual",
    "eventual",
  ])
  expect(requests.map((r) => params(r.url).get("$count"))).toEqual([null, "true", "true"])
})

// Countercheck: drop `minimal` from the cursor options in pages(); page two returns full objects.
test("delta tracks the tenant's contacts, scoped by ID, from now on, or with minimal changes", async () => {
  const next = `${GRAPH}contacts/delta?$skiptoken=opaque%2B`
  const deltaLink = `${GRAPH}contacts/delta?$deltatoken=checkpoint`
  const requests = mockFetch((r) =>
    r.url === next
      ? json({
          value: [{ id: "b", "@removed": { reason: "changed" } }],
          "@odata.deltaLink": deltaLink,
        })
      : json({ value: [{ id: "a" }], "@odata.nextLink": next })
  )
  const { delta } = (await connect()).directory.contacts
  const pages = await collect(delta.pages({ select: ["displayName"], minimal: true }))
  expect(pages.map((p) => p.value.map((c) => c.id))).toEqual([["a"], ["b"]])
  expect(pages[1].value[0]["@removed"]?.reason).toBe("changed")
  expect(pathOf(requests[0].url)).toBe(pathOf(`${GRAPH}contacts/delta`))
  expect(params(requests[0].url).get("$select")).toBe("id,displayName")
  expect(requests[1].url).toBe(next)
  expect(requests.map((r) => r.headers.get("prefer"))).toEqual(["return=minimal", "return=minimal"])

  const scoped = mockFetch(() => json({ value: [], "@odata.deltaLink": deltaLink }))
  await delta.list({ ids: ["a", "o'b"] })
  await delta.list({ latest: true })
  expect(params(scoped[0].url).get("$filter")).toBe("id eq 'a' or id eq 'o''b'")
  expect(params(scoped[1].url).get("$deltatoken")).toBe("latest")
  expect(scoped[1].headers.get("prefer")).toBeNull()
})

test("directory delta rejects invalid scopes, combined cursors, hostile links and cycles", async () => {
  const requests = mockFetch(() => json({ value: [] }))
  const { delta } = (await connect()).directory.contacts
  for (const options of [
    { ids: [] },
    { ids: Array.from({ length: 51 }, (_, i) => `id${i}`) },
    { ids: [" "] },
    { top: 5 },
    { cursor: `${GRAPH}contacts/delta?$deltatoken=x`, latest: true },
    { cursor: `${GRAPH}contacts/delta?$deltatoken=x`, select: ["mail"] },
  ])
    await expect(delta.list(options as OrgContactDeltaOptions)).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
  await expect(delta.list({ cursor: "https://evil.example/steal" })).rejects.toBeInstanceOf(
    MicrosoftProtocolError
  )
  expect(requests).toHaveLength(0)
  await expect(delta.list()).rejects.toBeInstanceOf(MicrosoftProtocolError)
  const loop = `${GRAPH}contacts/delta?$skiptoken=loop`
  mockFetch(() => json({ value: [], "@odata.nextLink": loop }))
  await expect(collect(delta.pages({ cursor: loop }))).rejects.toBeInstanceOf(
    MicrosoftProtocolError
  )
  mockFetch(() => apiError(410, "SyncStateNotFound", { Location: `${GRAPH}contacts/delta` }))
  await expect(delta.list({ cursor: loop })).rejects.toMatchObject({
    status: 410,
    location: `${GRAPH}contacts/delta`,
  })
})
