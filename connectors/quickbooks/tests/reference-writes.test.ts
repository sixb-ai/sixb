import { afterEach, expect, test } from "bun:test"
import { QuickBooksApiError, type QuickBooksClient, quickbooks } from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
async function client(hostileRetries = true): Promise<QuickBooksClient> {
  return quickbooks({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    // A hostile custom policy must still never replay writes.
    retry: hostileRetries
      ? { maxRetries: 2, shouldRetry: () => true, delayMs: () => 0 }
      : { maxRetries: 0 },
  }).connect({
    projectId: "test",
    connectorId: "qb",
    connectionId: "c",
    account: { id: "123", label: "Company" },
    signal: new AbortController().signal,
    tokenSource: {
      async get() {
        return { accessToken: "token", invalidate() {} }
      },
    },
  })
}
function mock(handler: (url: URL, init: RequestInit) => Response) {
  globalThis.fetch = ((input, init) =>
    Promise.resolve(handler(new URL(String(input)), init ?? {}))) as typeof fetch
}
const identity = { Id: "42", SyncToken: "0" }
const options = { requestId: "persisted-key" }

const cases = [
  {
    resource: "employees",
    entity: "Employee",
    nameField: "DisplayName",
    create: { GivenName: "Ada", FamilyName: "Example", DisplayName: "Ada Example", BillRate: 45 },
    update: { ...identity, HiredDate: "2026-09-01", CostRate: 30 },
  },
  {
    resource: "classes",
    entity: "Class",
    nameField: "Name",
    create: { Name: "Hardscape", SubClass: true, ParentRef: { value: "1" } },
    update: { ...identity, Name: "Hardscaping" },
  },
  {
    resource: "departments",
    entity: "Department",
    nameField: "Name",
    create: { Name: "North yard" },
    update: { ...identity, Name: "North" },
  },
  {
    resource: "paymentMethods",
    entity: "PaymentMethod",
    nameField: "Name",
    create: { Name: "Crew card", Type: "CREDIT_CARD" as const },
    update: { ...identity, Type: "NON_CREDIT_CARD" as const },
  },
] as const

for (const c of cases) {
  test(`${c.resource}: create, sparse update and activation use the ${c.entity} envelope`, async () => {
    const qb = await client()
    const resource = qb[c.resource] as unknown as {
      create(input: object, options?: object): Promise<unknown>
      update(input: object, options?: object): Promise<unknown>
      deactivate(input: object, options?: object): Promise<unknown>
      reactivate(input: object, options?: object): Promise<unknown>
    }
    const bodies: unknown[] = []
    mock((url, init) => {
      expect(url.pathname).toBe(`/v3/company/123/${c.entity.toLowerCase()}`)
      expect(url.searchParams.get("requestid")).toBe(options.requestId)
      expect(url.searchParams.get("minorversion")).toBe("75")
      expect(init.method).toBe("POST")
      bodies.push(JSON.parse(String(init.body)))
      return Response.json({ [c.entity]: { ...identity, providerField: "retained" } })
    })
    expect(await resource.create(c.create, options)).toHaveProperty("providerField", "retained")
    await resource.update(c.update, options)
    // Class/Department updates require Name (live error 2020 without it); activation carries it.
    const name = c.entity === "Class" || c.entity === "Department" ? { Name: "Example" } : {}
    await resource.deactivate({ ...identity, ...c.create, ...name }, options)
    await resource.reactivate({ ...identity, ...name }, options)
    expect(bodies).toEqual([
      c.create,
      { ...c.update, sparse: true },
      { ...identity, ...name, Active: false, sparse: true },
      { ...identity, ...name, Active: true, sparse: true },
    ])
  })

  test(`${c.resource}: reads use the ${c.entity} path and ${c.nameField} name filter`, async () => {
    const qb = await client(false)
    mock((url) => {
      expect(url.pathname).toBe(`/v3/company/123/${c.entity.toLowerCase()}/42`)
      return Response.json({ [c.entity]: { ...identity, ...c.create } })
    })
    expect(await qb[c.resource].get("42")).toEqual({ ...identity, ...c.create })
    mock((url) => {
      expect(url.searchParams.get("query")).toBe(
        `SELECT * FROM ${c.entity} WHERE Active = false AND ${c.nameField} = 'Example' ORDERBY ${c.nameField} DESC STARTPOSITION 1 MAXRESULTS 100`
      )
      return Response.json({ QueryResponse: {} })
    })
    await qb[c.resource].list({
      active: false,
      name: "Example",
      orderBy: { field: c.nameField as "Name" & "DisplayName", direction: "DESC" },
    })
  })
}

test("reference writes are sent once even when the response is a provider fault", async () => {
  const qb = await client()
  let calls = 0
  mock(() => {
    calls++
    return Response.json(
      { Fault: { type: "ValidationFault", Error: [{ code: "6240", Message: "Duplicate Name" }] } },
      { status: 400 }
    )
  })
  const error = await qb.classes.create({ Name: "Dup" }, options).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(QuickBooksApiError)
  expect(error).toHaveProperty("writeRequestId", options.requestId)
  expect(calls).toBe(1)
})

test("invalid reference write inputs reject before network access", async () => {
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  const qb = await client()
  // Live: QuickBooks rejected DisplayName-only and GivenName-only employees with 2020.
  await expect(
    // @ts-expect-error GivenName and FamilyName are both required.
    qb.employees.create({ DisplayName: "Crew lead" })
  ).rejects.toThrow("GivenName")
  // @ts-expect-error FamilyName is required.
  await expect(qb.employees.create({ GivenName: "Ada" })).rejects.toThrow("FamilyName")
  await expect(qb.employees.create({ GivenName: " ", FamilyName: "Example" })).rejects.toThrow(
    "GivenName"
  )
  await expect(qb.employees.update({ ...identity, DisplayName: "" })).rejects.toThrow("DisplayName")
  await expect(qb.classes.create({ Name: "" })).rejects.toThrow("Name")
  // @ts-expect-error QuickBooks requires Name on every Class update.
  await expect(qb.classes.update({ ...identity, Active: false })).rejects.toThrow("Name")
  // @ts-expect-error Class activation also needs the current Name.
  await expect(qb.classes.deactivate(identity)).rejects.toThrow("Name")
  await expect(qb.classes.create({ Name: "Child", SubClass: true })).rejects.toThrow("ParentRef")
  await expect(
    qb.departments.create({ Name: "Child", SubDepartment: true, ParentRef: { value: "" } })
  ).rejects.toThrow("ParentRef")
  // @ts-expect-error QuickBooks requires Name on every Department update.
  await expect(qb.departments.reactivate(identity)).rejects.toThrow("Name")
  await expect(
    // @ts-expect-error Only the two provider payment method types are writable.
    qb.paymentMethods.create({ Name: "Cash", Type: "CASH" })
  ).rejects.toThrow("Type")
  await expect(qb.paymentMethods.create({ Name: "x", ...identity })).rejects.toThrow("Create input")
  await expect(qb.paymentMethods.deactivate({ Id: "42", SyncToken: "" })).rejects.toThrow(
    "SyncToken"
  )
  expect(calls).toBe(0)
})
