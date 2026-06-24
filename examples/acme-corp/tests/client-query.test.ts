/**
 * Round-trip e2e for `@sixb/client/query`: the client builder runs the same
 * queries as the server runtime against a real SixbServer over HTTP.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { client } from "@sixb/client"
import { createHttpQueryExecutor, objects, SixbQueryError } from "@sixb/client/query"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  type OntologySource,
  Sixb,
  type SixbOptions,
} from "@sixb/core"
import { SixbServer } from "@sixb/server"
import { SqliteStorage } from "@sixb/sqlite"
import { Customer } from "../ontology/customer"
import { Department } from "../ontology/department"
import { Employee } from "../ontology/employee"
import { Invoice } from "../ontology/invoice"
import { Project } from "../ontology/project"

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbOptions<TOntologySources>
): Sixb<TOntologySources> {
  const SixbConstructor = Sixb as unknown as new (
    options: SixbOptions<TOntologySources>
  ) => Sixb<TOntologySources>

  return new SixbConstructor(options)
}

function primaryIds(rows: readonly { primaryId: string }[]): string[] {
  return rows.map((row) => row.primaryId)
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a port"))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })
}

const storage = new SqliteStorage()

const sixb = createSixbInstance({
  id: "acme-client-query-e2e",
  ontology: [Project, Customer, Employee, Invoice, Department] as const,
  broker: new InMemoryBroker(),
  storage,
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
})

let server: SixbServer
let previousBaseUrl: string | undefined

beforeAll(async () => {
  await sixb.objects(Department).upsert({
    properties: { id: "dept-delivery", name: "Delivery", code: "DEL" },
  })
  await sixb.objects(Department).upsert({
    properties: { id: "dept-success", name: "Customer Success", code: "CS" },
  })

  const employees = [
    {
      id: "emp-account",
      name: "Ada Account",
      email: "ada@acme.test",
      role: "Account Manager",
      department: "dept-success",
    },
    {
      id: "emp-lead",
      name: "Lena Lead",
      email: "lena@acme.test",
      role: "Project Lead",
      department: "dept-delivery",
    },
    {
      id: "emp-builder",
      name: "Ben Builder",
      email: "ben@acme.test",
      role: "Engineer",
      department: "dept-delivery",
    },
  ] as const
  for (const employee of employees) {
    await sixb.objects(Employee).upsert({
      properties: {
        id: employee.id,
        name: employee.name,
        email: employee.email,
        role: employee.role,
      },
    })
    await sixb.objects(Employee).upsertLink({
      sourceId: employee.id,
      linkId: "department",
      targetTypeId: Department.id,
      targetId: employee.department,
    })
  }

  await sixb.objects(Customer).upsert({
    properties: {
      id: "cust-001",
      name: "Dana Smith",
      email: "dana@globex.test",
      company: "Globex",
      tier: "gold",
    },
  })
  await sixb.objects(Customer).upsertLink({
    sourceId: "cust-001",
    linkId: "accountManager",
    targetTypeId: Employee.id,
    targetId: "emp-account",
  })

  const projects = [
    {
      id: "proj-001",
      name: "Energy Dashboard",
      status: "active",
      budget: 120_000,
      deadline: "2026-09-30",
    },
    {
      id: "proj-002",
      name: "Warehouse Retrofit",
      status: "active",
      budget: 40_000,
      deadline: "2026-03-31",
    },
    {
      id: "proj-003",
      name: "Lobby Refresh",
      status: "completed",
      budget: 15_000,
      deadline: "2025-12-01",
    },
  ] as const
  for (const properties of projects) {
    await sixb.objects(Project).upsert({ properties })
  }
  for (const projectId of ["proj-001", "proj-002"]) {
    await sixb.objects(Project).upsertLink({
      sourceId: projectId,
      linkId: "customer",
      targetTypeId: Customer.id,
      targetId: "cust-001",
    })
  }
  await sixb.objects(Project).upsertLink({
    sourceId: "proj-001",
    linkId: "lead",
    targetTypeId: Employee.id,
    targetId: "emp-lead",
  })
  for (const employeeId of ["emp-lead", "emp-builder"]) {
    await sixb.objects(Project).upsertLink({
      sourceId: "proj-001",
      linkId: "members",
      targetTypeId: Employee.id,
      targetId: employeeId,
    })
  }

  // Invoice shares the "customer" link id with Project, so incoming traversal
  // is ambiguous unless the traverse node pins the source object type.
  await sixb.objects(Invoice).upsert({
    properties: { id: "inv-001", number: "INV-001", amount: 1_200, status: "sent" },
  })
  await sixb.objects(Invoice).upsertLink({
    sourceId: "inv-001",
    linkId: "customer",
    targetTypeId: Customer.id,
    targetId: "cust-001",
  })

  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  server = new SixbServer({
    sixb: sixb as unknown as Sixb<readonly OntologySource[]>,
    host: "127.0.0.1",
    port,
    quiet: true,
    browser: {
      publicOrigin: baseUrl,
      allowedOrigins: [{ origin: baseUrl, audience: "atlas", kind: "atlas" }],
    },
  })
  await server.start()
  previousBaseUrl = client.getConfig().baseUrl
  client.setConfig({ baseUrl })
})

afterAll(async () => {
  client.setConfig({ baseUrl: previousBaseUrl })
  await server?.stop()
  storage.close()
})

describe("client object queries against a live server", () => {
  test("client and server builders produce the same IR", () => {
    const fromClient = objects(Project)
      .query()
      .where((project) => project.p.status.eq("active"))
      .orderBy(Project.p.deadline, "asc")
      .limit(20)

    const fromServer = sixb
      .objects(Project)
      .query()
      .where((project) => project.p.status.eq("active"))
      .orderBy(Project.p.deadline, "asc")
      .limit(20)

    expect(fromClient.ir).toEqual(fromServer.ir)
  })

  test("list() returns the same objects as the server runtime", async () => {
    const viaHttp = await objects(Project)
      .query()
      .where((project) => project.and(project.p.status.eq("active"), project.p.budget.gte(50_000)))
      .orderBy(Project.p.deadline, "asc")
      .limit(10)
      .list()

    const viaRuntime = await sixb
      .objects(Project)
      .query()
      .where((project) => project.and(project.p.status.eq("active"), project.p.budget.gte(50_000)))
      .orderBy(Project.p.deadline, "asc")
      .limit(10)
      .list()

    expect(viaHttp.total).toBe(1)
    expect(primaryIds(viaHttp.objects)).toEqual(primaryIds(viaRuntime.objects))
    expect(viaHttp.objects[0]?.properties.name).toBe("Energy Dashboard")
    expect(viaHttp.objects[0]?.createdAt).toBeInstanceOf(Date)
  })

  test("expands the real projects page graph", async () => {
    const project = await objects(Project)
      .query()
      .where((project) => project.p.id.eq("proj-001"))
      .expand(Project.l.customer, (customer) => customer.expand(Customer.l.accountManager))
      .expand(Project.l.lead, (lead) => lead.expand(Employee.l.department))
      .expand(Project.l.members, {
        limit: 2,
        orderBy: [{ property: Employee.p.name, direction: "asc" }],
      })
      .first()

    expect(project?.links.customer?.properties.company).toBe("Globex")
    expect(project?.links.customer?.links.accountManager?.properties.name).toBe("Ada Account")
    expect(project?.links.lead?.properties.name).toBe("Lena Lead")
    expect(project?.links.lead?.links.department?.properties.name).toBe("Delivery")

    const memberNames: string[] = []
    for (const member of project?.links.members ?? []) {
      memberNames.push(member.properties.name)
    }
    expect(memberNames).toEqual(["Ben Builder", "Lena Lead"])
  })

  test("Date predicate values survive the JSON wire format", async () => {
    const dueSoon = await objects(Project)
      .query()
      .where((project) => project.p.deadline.lte(new Date("2026-06-30")))
      .orderBy(Project.p.deadline, "asc")
      .limit(10)
      .list()

    expect(primaryIds(dueSoon.objects)).toEqual(["proj-003", "proj-002"])
  })

  test("count, exists, and facets round-trip", async () => {
    const active = objects(Project)
      .query()
      .where((project) => project.p.status.eq("active"))

    expect(await active.count()).toBe(2)
    expect(await active.exists()).toBe(true)

    const facets = await objects(Project)
      .query()
      .facets([{ property: Project.p.status, limit: 10 }])
    expect(facets[0]?.propertyId).toBe("status")
    expect(facets[0]?.buckets).toEqual(
      expect.arrayContaining([
        { value: "active", count: 2 },
        { value: "completed", count: 1 },
      ])
    )
  })

  test("incoming traverse returns only the link token's source type", async () => {
    const viaToken = await objects(Customer)
      .query()
      .where((customer) => customer.p.id.eq("cust-001"))
      .traverse(Project.l.customer, { direction: "incoming" })
      .list()
    expect(primaryIds(viaToken.objects).sort()).toEqual(["proj-001", "proj-002"])

    // Raw IR without sourceObjectTypeId keeps the union behavior.
    const union = await createHttpQueryExecutor().list({
      kind: "traverse",
      linkId: "customer",
      direction: "incoming",
      input: {
        kind: "filter",
        predicate: { op: "eq", propertyId: "id", value: "cust-001" },
        input: { kind: "start", objectTypeId: Customer.id },
      },
    })
    expect([...union.objects].map((row) => row.primaryId).sort()).toEqual([
      "inv-001",
      "proj-001",
      "proj-002",
    ])
  })

  test("incoming traverse finds a customer's active projects", async () => {
    const customerProjects = await objects(Customer)
      .query()
      .where((customer) => customer.p.id.eq("cust-001"))
      .traverse(Project.l.customer, { direction: "incoming" })
      .where((project) => project.p.status.eq("active"))
      .orderBy(Project.p.deadline, "asc")
      .list()

    expect(primaryIds(customerProjects.objects)).toEqual(["proj-002", "proj-001"])
  })

  test("server validation errors surface as SixbQueryError with issues", async () => {
    const promise = objects(Project)
      .query()
      .where((project) => project.p.description.eq("nope"))
      .limit(1)
      .list()

    expect(promise).rejects.toThrow(SixbQueryError)
    await promise.catch((error: SixbQueryError) => {
      expect(error.issues.length).toBeGreaterThan(0)
    })
  })

  test("infinite-style paging threads nextPageToken", async () => {
    const firstPage = await objects(Project)
      .query()
      .orderBy(Project.p.deadline, "asc")
      .page({ pageSize: 2 })
      .list({ includeTotal: false })

    expect(firstPage.objects).toHaveLength(2)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.nextPageToken).toBeTruthy()

    const secondPage = await objects(Project)
      .query()
      .orderBy(Project.p.deadline, "asc")
      .page({ pageSize: 2, pageToken: firstPage.nextPageToken })
      .list({ includeTotal: false })

    expect(secondPage.objects).toHaveLength(1)
    expect(secondPage.hasMore).toBe(false)
  })
})
