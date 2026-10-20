import { afterEach, expect, test } from "bun:test"
import { isMailboxNotEnabled, MicrosoftApiError, MicrosoftConfigurationError } from "../src"
import { apiError, collect, connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)
const params = (url: string) => new URL(url).searchParams
const pathOf = (url: string) => new URL(url).pathname

test("users list tenant-wide, with selected properties and up to 999 a page", async () => {
  const requests = mockFetch(() =>
    json({ value: [{ id: "u", userPrincipalName: "ana@contoso.com", userType: "Member" }] })
  )
  const { users } = (await connect()).directory
  const result = await users.list({ select: ["userPrincipalName", "userType"], top: 999 })
  expect(result.value[0].userType).toBe("Member")
  expect(pathOf(requests[0].url)).toBe(pathOf(`${GRAPH}users`))
  expect(params(requests[0].url).get("$select")).toBe("id,userPrincipalName,userType")
  expect(params(requests[0].url).get("$top")).toBe("999")
  expect(requests[0].headers.get("consistencylevel")).toBeNull()
})

// Countercheck: drop request.headers from directoryListAll's allPages call; page two loses eventual
// consistency.
test("licensed-member filters are advanced queries on every page", async () => {
  const filter = "accountEnabled eq true and userType eq 'Member' and assignedLicenses/$count ne 0"
  const next = `${GRAPH}users?$skiptoken=opaque`
  const requests = mockFetch((r) =>
    r.url === next
      ? json({ value: [{ id: "b" }] })
      : json({ value: [{ id: "a" }], "@odata.count": 2, "@odata.nextLink": next })
  )
  const { users } = (await connect()).directory
  const all = await collect(users.listAll({ filter, advancedQuery: true, select: ["mail"] }))
  expect(all.map((user) => user.id)).toEqual(["a", "b"])
  expect(params(requests[0].url).get("$filter")).toBe(filter)
  expect(params(requests[0].url).get("$count")).toBe("true")
  expect(requests[1].url).toBe(next)
  expect(requests.map((r) => r.headers.get("consistencylevel"))).toEqual(["eventual", "eventual"])

  const counted = await users.list({ search: '"displayName:ana"' })
  expect(counted["@odata.count"]).toBe(2)
  expect(requests[2].headers.get("consistencylevel")).toBe("eventual")
  await expect(users.list({ advancedQuery: true, expand: "manager" })).rejects.toBeInstanceOf(
    MicrosoftConfigurationError
  )
  expect(requests).toHaveLength(3)
})

test("listAll retries a throttled page and keeps going", async () => {
  const next = `${GRAPH}users?$skiptoken=opaque`
  let throttled = false
  const requests = mockFetch((r) => {
    if (r.url !== next) return json({ value: [{ id: "a" }], "@odata.nextLink": next })
    if (throttled) return json({ value: [{ id: "b" }] })
    throttled = true
    return apiError(429, "TooManyRequests", { "retry-after": "0" })
  })
  const { users } = (await connect({ retry: { maxRetries: 1 } })).directory
  expect((await collect(users.listAll())).map((user) => user.id)).toEqual(["a", "b"])
  expect(requests.map((r) => r.url)).toEqual([`${GRAPH}users`, next, next])
})

// Countercheck: send every key through `users/${segment(id)}`; the `$` case must fail.
test("get takes an ID or UPN, including guest and $-prefixed UPNs", async () => {
  const requests = mockFetch(() => json({ id: "u" }))
  const { users } = (await connect()).directory
  await users.get("87d349ed-44d7-43e1-9a83-5f2406dee5bd", { select: ["accountEnabled"] })
  await users.get("ana_fabrikam.com#EXT#@contoso.com", { expand: "manager" })
  await users.get("$svc@contoso.com", { select: ["mail"] })
  await users.get("$o'neil@contoso.com")
  expect(requests.map((r) => r.url.slice(GRAPH.length))).toEqual([
    "users/87d349ed-44d7-43e1-9a83-5f2406dee5bd?%24select=id%2CaccountEnabled",
    "users/ana_fabrikam.com%23EXT%23%40contoso.com?%24expand=manager",
    "users(%27%24svc%40contoso.com%27)?%24select=id%2Cmail",
    "users(%27%24o%27%27neil%40contoso.com%27)",
  ])
  for (const id of ["", " ", "..", "."])
    await expect(users.get(id)).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  expect(requests).toHaveLength(4)
  mockFetch(() => apiError(404, "Request_ResourceNotFound"))
  await expect(users.get("gone@contoso.com")).rejects.toMatchObject({ status: 404 })
})

test("isMailboxNotEnabled matches only Graph's no-mailbox answer", async () => {
  const client = await connect()
  const failure = async (response: Response) => {
    mockFetch(() => response)
    return collect(client.contacts.folders.listAll("svc@contoso.com")).catch((e: unknown) => e)
  }
  const noMailbox = await failure(apiError(404, "MailboxNotEnabledForRESTAPI"))
  expect(noMailbox).toBeInstanceOf(MicrosoftApiError)
  expect(isMailboxNotEnabled(noMailbox)).toBe(true)
  for (const response of [
    apiError(404, "ErrorInvalidUser"),
    apiError(404, "ResourceNotFound"),
    apiError(403, "MailboxNotEnabledForRESTAPI"),
    apiError(403, "ErrorAccessDenied"),
  ])
    expect(isMailboxNotEnabled(await failure(response))).toBe(false)
  for (const error of [
    new Error("MailboxNotEnabledForRESTAPI"),
    { status: 404, code: "MailboxNotEnabledForRESTAPI" },
    undefined,
  ])
    expect(isMailboxNotEnabled(error)).toBe(false)
})
