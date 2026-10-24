import { describe, expect, test } from "bun:test"
import type { ArtifactFile, ArtifactRequestErrorCode, AuthorizationContext } from "../src"
import {
  ArtifactRequestError,
  AuthorizationError,
  defineMarking,
  defineObjectType,
  link,
  prop,
  ref,
  SixbHost,
} from "../src"
import { ARTIFACT_LIMITS } from "../src/artifacts/limits"
import { prepareArtifactVersion } from "../src/artifacts/publish"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "artifact-queries"
const financial = defineMarking("financial")

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("status", "string", { query: { searchable: true, filterable: true, facet: true } }),
    prop("amount", "double", {
      markings: [financial],
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("dueDate", "date"),
  ],
})

/** Who an invoice bills, and the marked tax id an expansion of it would return. */
const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string"),
    prop("taxId", "string", { markings: [financial] }),
  ],
})

const Billed = defineObjectType({ ...Invoice, links: [link("customer", Customer)] })

/** An invoice with the member who owns it, whose profile a query may expand. */
const Owned = defineObjectType({
  ...Invoice,
  properties: [...Invoice.properties, prop("owner", ref.user(), { nullable: true })],
})

type Ontology = ConstructorParameters<typeof SixbHost>[0]["ontology"]

function setup(deps = createTestRuntimeDeps(), ontology: Ontology = [Invoice]) {
  const host = new SixbHost({ id: projectId, ontology, markings: [financial], ...deps })

  const as = (
    id: string,
    options: {
      readonly views?: readonly string[]
      readonly cleared?: boolean
      readonly members?: boolean
    } = {}
  ) => {
    const authorization: AuthorizationContext = {
      principal: { type: "user", id },
      groupIds: [],
      roleIds: [],
      grants: {
        ...emptyGrantIndex(),
        "view:object": new Set(options.views ?? ["Invoice"]),
        "view:users": options.members === true,
      },
      ...(options.cleared ? { clearances: new Set([financial.id]) } : {}),
    }
    return createTestSixb(host, { authorization })
  }

  const put = async (path: string, body: string): Promise<ArtifactFile> => ({
    path,
    file: await deps.blobStorage.put({
      body: new TextEncoder().encode(body),
      fileName: path.split("/").at(-1) ?? path,
    }),
  })

  /** A page that shows its queries, each given by name. */
  const page = async (queries: Record<string, unknown>) => ({
    kind: "page" as const,
    title: "Overdue",
    files: [
      await put("index.html", "<!doctype html><title>Overdue</title><p>Overdue</p>"),
      ...(await Promise.all(
        Object.entries(queries).map(([name, query]) =>
          put(`queries/${name}.json`, typeof query === "string" ? query : JSON.stringify(query))
        )
      )),
    ],
  })

  return { host, deps, as, put, page }
}

async function refusal(promise: Promise<unknown>): Promise<ArtifactRequestError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ArtifactRequestError)
  return error as ArtifactRequestError
}

async function expectRefused(
  promise: Promise<unknown>,
  message: string,
  code: ArtifactRequestErrorCode = "invalid_artifact"
) {
  const error = await refusal(promise)
  expect({ code: error.code, message: error.message }).toEqual({ code, message })
}

const start = { kind: "start", objectTypeId: "Invoice" }
const open = {
  kind: "filter",
  input: start,
  predicate: { op: "eq", propertyId: "status", value: "open" },
}

describe("publishing a version that holds queries", () => {
  test("keeps each query among its files, as a node, a request, or a facets request", async () => {
    const { as, page } = setup()

    const published = await as("alice", { cleared: true }).artifacts.create(
      await page({
        open,
        "open-request": { query: open, includeTotal: true },
        statuses: { query: start, facets: [{ propertyId: "status", limit: 10 }] },
      })
    )

    expect(published.version.files.map((file) => file.path)).toEqual([
      "index.html",
      "queries/open.json",
      "queries/open-request.json",
      "queries/statuses.json",
    ])
  })

  test("refuses a query that is not one, naming the file and where in it", async () => {
    const { as, page } = setup()
    const alice = as("alice")

    await expectRefused(
      alice.artifacts.create(await page({ broken: "{" })),
      "[Sixb] queries/broken.json is not valid JSON."
    )
    await expectRefused(
      alice.artifacts.create(await page({ unknown: { kind: "start", objectTypeId: "Deal" } })),
      "[Sixb] queries/unknown.json: $: Unknown object type 'Deal'. Object type IDs are case-sensitive."
    )
    await expectRefused(
      alice.artifacts.create(
        await page({
          due: {
            query: {
              kind: "filter",
              input: start,
              predicate: { op: "lt", propertyId: "dueDate", value: "2026-10-01" },
            },
          },
        })
      ),
      "[Sixb] queries/due.json: $.query.predicate: Property 'dueDate' on 'Invoice' must set query.searchable: true and query.filterable: true before it can be used in predicates"
    )
    await expectRefused(
      alice.artifacts.create(
        await page({ facets: { query: start, facets: [{ propertyId: "dueDate", limit: 5 }] } })
      ),
      "[Sixb] queries/facets.json: $.facets[0].propertyId: Property 'dueDate' on 'Invoice' must set query.searchable: true and query.facet: true before it can be used as a facet"
    )
    // Resolved by core, never written: refused as the API refuses it.
    await expectRefused(
      alice.artifacts.create(
        await page({
          forged: {
            ...open,
            predicate: { ...open.predicate, scalarKind: "string" },
          },
        })
      ),
      '[Sixb] queries/forged.json: $.predicate.scalarKind: is not a key of an "eq" predicate.'
    )
    await expectRefused(
      alice.artifacts.create(await page({ Open: open })),
      "[Sixb] 'queries/Open.json' is not a query: name it queries/<name>.json, with lowercase letters, digits and hyphens, at most 64 characters."
    )
  })

  // Guard proof: remove "page" from REFUSED_NODES in queries.ts; the first refusal then names the
  // page node as an unknown kind. Remove "vector", and the second does.
  test("refuses a page, a vector search and a reranking, saying why", async () => {
    const { as, page } = setup()
    const alice = as("alice")

    await expectRefused(
      alice.artifacts.create(await page({ paged: { kind: "page", input: start, pageSize: 50 } })),
      '[Sixb] queries/paged.json: $.kind: "page" is not allowed in an artifact\'s query: Sixb pages the result for each reader; bound the query with "limit" instead.'
    )
    await expectRefused(
      alice.artifacts.create(
        await page({
          similar: {
            query: {
              kind: "limit",
              limit: 10,
              input: { kind: "vector", input: start, vector: "late", profile: "notes", k: 10 },
            },
          },
        })
      ),
      '[Sixb] queries/similar.json: $.query.input.kind: "vector" is not allowed in an artifact\'s query: each reader who opens the artifact would pay for an embedding call.'
    )
  })

  test("refuses more queries than a version holds, and a query file past its size", async () => {
    const { as, page } = setup()
    const alice = as("alice")

    const many = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`query-${index + 1}`, open])
    )
    await expectRefused(
      alice.artifacts.create(await page(many)),
      "[Sixb] A version holds at most 20 queries; this one has 21."
    )

    // Just past 64 KB, padded with spaces JSON ignores.
    const padded = JSON.stringify(open).padEnd(64 * 1024 + 1, " ")
    await expectRefused(
      alice.artifacts.create(await page({ padded })),
      "[Sixb] 'queries/padded.json' is 65537 bytes; it may be at most 65536."
    )
  })

  test("refuses queries in a document, which shows a live sheet instead", async () => {
    const { as, put } = setup()

    await expectRefused(
      as("alice").artifacts.create({
        kind: "document",
        title: "Overdue",
        files: [
          await put("document.md", "# Overdue"),
          await put("queries/open.json", JSON.stringify(open)),
        ],
      }),
      "[Sixb] 'queries/open.json': a document runs no query. A document shows a live sheet instead."
    )
  })

  // Guard proof: return early from createArtifactQueryChecker's checker; both versions then
  // publish.
  test("refuses a query its author could not run: a type they cannot view, a filter they are not cleared for", async () => {
    const { as, page } = setup()

    await expectRefused(
      as("bob", { views: [] }).artifacts.create(await page({ open })),
      "[Sixb] queries/open.json: Principal 'bob' is not allowed to view object type 'Invoice'."
    )

    const large = {
      kind: "filter",
      input: start,
      predicate: { op: "gt", propertyId: "amount", value: 1000 },
    }
    await expectRefused(
      as("bob").artifacts.create(await page({ large })),
      "[Sixb] queries/large.json: Cannot filter by 'Invoice.amount' at '$.predicate': it requires clearance for marking 'financial'."
    )

    // Cleared, the same query publishes.
    await as("alice", { cleared: true }).artifacts.create(await page({ large }))
  })

  // Guard proof: drop the assertReturnsReadable call from createArtifactQueryChecker; each of
  // Bob's queries then publishes, and a cleared reader's rows would reach his page with amounts.
  test("refuses a query that returns what its author is not cleared to read, naming it", async () => {
    const { as, page } = setup(createTestRuntimeDeps(), [Billed, Customer])
    const views = ["Invoice", "Customer"]
    const bob = as("bob", { views })

    const statuses = { kind: "project", input: open, properties: ["id", "status"] }
    const customers = {
      kind: "expand",
      input: statuses,
      expansions: [{ linkId: "customer", direction: "outgoing" }],
    }

    await expectRefused(
      bob.artifacts.create(await page({ all: { query: open } })),
      "[Sixb] queries/all.json: $.query: returns 'amount' on 'Invoice', which you are not cleared to read: add a \"project\" node that lists only the properties you can read."
    )
    await expectRefused(
      bob.artifacts.create(await page({ amounts: { ...statuses, properties: ["id", "amount"] } })),
      "[Sixb] queries/amounts.json: $.properties[1]: returns 'amount' on 'Invoice', which you are not cleared to read: list only the properties you can read."
    )
    await expectRefused(
      bob.artifacts.create(await page({ customers })),
      "[Sixb] queries/customers.json: $.expansions[0]: expands 'customer' to 'Customer', whose 'taxId' you are not cleared to read: an expansion returns every property, so leave it out, or read 'Customer' in a query of its own with a \"project\" node."
    )

    // Without what he cannot read, his query publishes.
    await bob.artifacts.create(await page({ statuses }))

    // Cleared, the same queries publish as they are.
    const { version } = await as("alice", { views, cleared: true }).artifacts.create(
      await page({ all: { query: open }, customers })
    )
    expect(version.files.map((file) => file.path)).toEqual([
      "index.html",
      "queries/all.json",
      "queries/customers.json",
    ])
  })

  // Guard proof: drop the assertExpandsNoUsers call from createArtifactQueryChecker; Bob's query
  // then publishes, and a reader who views members would hand their profiles to his page.
  test("refuses a query that expands member profiles its author may not view", async () => {
    const { as, page } = setup(createTestRuntimeDeps(), [Owned])
    const owners = {
      kind: "expand",
      input: { kind: "project", input: start, properties: ["id", "owner"] },
      expansions: [],
      users: ["owner"],
    }

    await expectRefused(
      as("bob").artifacts.create(await page({ owners })),
      "[Sixb] queries/owners.json: $.users[0]: returns the member profiles 'owner' refers to, which you are not allowed to view: leave 'owner' out of \"users\"."
    )

    // Allowed to view members, he publishes it.
    await as("bob", { members: true }).artifacts.create(await page({ owners }))
  })

  // Guard proof: return instead of throwing at the `!checker` refusal in checkArtifactQueries; the
  // version is then prepared with a query nobody checked.
  test("refuses a version with queries when nothing checks them as its author", async () => {
    const { host, deps, page } = setup()
    const storage = host.storage.artifacts
    if (!storage) throw new Error("Expected artifact storage.")

    await expectRefused(
      prepareArtifactVersion(
        { projectId, storage, blobStorage: deps.blobStorage },
        { ...(await page({ open })), author: { type: "user", id: "alice" } }
      ),
      "[Sixb] 'queries/open.json' is a query, and this publish has no way to check it as its author."
    )
  })
})

/** `count` invoices, open, numbered from 1 in primary-id order. */
async function seedInvoices(host: SixbHost, count: number) {
  const items = Array.from({ length: count }, (_, index) => ({
    properties: { id: `inv_${String(index + 1).padStart(5, "0")}`, status: "open", amount: 100 },
  }))

  const sixb = createTestSixb(host)
  for (let index = 0; index < items.length; index += 1_000) {
    await sixb.objects.upsertBatch(Invoice.id, items.slice(index, index + 1_000))
  }
}

describe("reading a version's query", () => {
  test("runs it as the reader, and says what it returns and reads", async () => {
    const { host, as, page } = setup()
    await seedInvoices(host, 3)
    const alice = as("alice", { cleared: true })
    const { artifact } = await alice.artifacts.create(
      await page({
        open,
        statuses: { query: start, facets: [{ propertyId: "status", limit: 10 }] },
      })
    )

    const rows = await alice.artifacts.query(artifact.id, "open")
    expect(rows).toMatchObject({
      kind: "objects",
      total: 3,
      truncated: false,
      resultObjectTypeIds: ["Invoice"],
      readObjectTypeIds: ["Invoice"],
    })
    expect(rows?.kind === "objects" && rows.objects[0]?.properties).toEqual({
      id: "inv_00001",
      status: "open",
      amount: 100,
    })

    expect(await alice.artifacts.query(artifact.id, "statuses", { version: 1 })).toEqual({
      kind: "facets",
      total: 3,
      facets: [{ propertyId: "status", buckets: [{ value: "open", count: 3 }] }],
      resultObjectTypeIds: ["Invoice"],
      readObjectTypeIds: ["Invoice"],
      schema: {
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          amount: { type: "double" },
          dueDate: { type: "date" },
        },
        links: {},
      },
    })
  })

  test("leaves out what the reader is not cleared for, and refuses what they cannot view", async () => {
    const { host, as, page } = setup()
    await seedInvoices(host, 1)
    const { artifact } = await as("bob", { cleared: true }).artifacts.create(await page({ open }))

    // Bob is no longer cleared: his own artifact's query leaves the amount out.
    const uncleared = await as("bob").artifacts.query(artifact.id, "open")
    expect(uncleared?.kind === "objects" && uncleared.objects[0]).toMatchObject({
      properties: { id: "inv_00001", status: "open" },
      redactions: { amount: { reason: "missing_clearance" } },
    })
    expect(uncleared?.kind === "objects" && uncleared.objects[0]?.properties).not.toHaveProperty(
      "amount"
    )

    // Bob no longer views invoices: his own artifact's query is refused as his read would be.
    const refused = await as("bob", { views: [] })
      .artifacts.query(artifact.id, "open")
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(AuthorizationError)
  })

  // Guard proof: return `truncated: false` once the cap is reached in readRows; the capped read
  // then says nothing is left out.
  test("reads past one page, and up to the cap, within the query's own limit", async () => {
    const { host, page } = setup()
    await seedInvoices(host, ARTIFACT_LIMITS.maxQueryRows + 1)
    const sixb = createTestSixb(host)
    const { artifact } = await sixb.artifacts.create(
      await page({
        // Just past the first page.
        first: { kind: "limit", input: start, limit: 1_000 },
        all: start,
        five: { kind: "limit", input: start, limit: 5 },
      })
    )

    const capped = await sixb.artifacts.query(artifact.id, "all")
    expect(capped?.kind === "objects" && capped.objects.length).toBe(ARTIFACT_LIMITS.maxQueryRows)
    expect(capped).toMatchObject({ total: ARTIFACT_LIMITS.maxQueryRows + 1, truncated: true })
    const ids = capped?.kind === "objects" ? capped.objects.map((row) => row.primaryId) : []
    expect(new Set(ids).size).toBe(ARTIFACT_LIMITS.maxQueryRows)
    expect(ids.at(1_000)).toBe("inv_01001")

    expect(await sixb.artifacts.query(artifact.id, "five")).toMatchObject({
      total: 5,
      truncated: false,
      objects: { length: 5 },
    })
    expect(await sixb.artifacts.query(artifact.id, "first")).toMatchObject({
      total: 1_000,
      truncated: false,
      objects: { length: 1_000 },
    })
  })

  test("crosses a page boundary", async () => {
    const { host, page } = setup()
    await seedInvoices(host, 1_001)
    const sixb = createTestSixb(host)
    const { artifact } = await sixb.artifacts.create(await page({ all: start }))

    const rows = await sixb.artifacts.query(artifact.id, "all")
    expect(rows).toMatchObject({ total: 1_001, truncated: false, objects: { length: 1_001 } })
    expect(rows?.kind === "objects" && rows.objects.at(-1)?.primaryId).toBe("inv_01001")
  })

  test("refuses a query the ontology no longer admits, and one the version does not hold", async () => {
    const { deps, page } = setup()
    const before = setup(deps)
    const { artifact } = await createTestSixb(before.host).artifacts.create(await page({ open }))

    // The same project, its status no longer filterable.
    const Unfiltered = defineObjectType({
      ...Invoice,
      properties: Invoice.properties.map((property) =>
        property.id === "status" ? { ...property, query: undefined } : property
      ),
    })
    const after = setup(deps, [Unfiltered])
    const sixb = createTestSixb(after.host)

    await expectRefused(
      sixb.artifacts.query(artifact.id, "open"),
      "[Sixb] Query 'open' no longer matches the ontology: $.predicate: Property 'status' on 'Invoice' must set query.searchable: true and query.filterable: true before it can be used in predicates",
      "query_invalid"
    )
    await expectRefused(
      sixb.artifacts.query(artifact.id, "closed"),
      `[Sixb] Version 1 of artifact '${artifact.id}' has no query 'closed'.`,
      "query_not_found"
    )
    expect(await sixb.artifacts.query(artifact.id, "open", { version: 2 })).toBeNull()
    expect(await sixb.artifacts.query("art_0000000000", "open")).toBeNull()
  })
})

describe("publishing queries from query builders", () => {
  test("stores each one as its query file, which each reader runs", async () => {
    const { host, as, put } = setup()
    await seedInvoices(host, 2)
    const alice = as("alice", { cleared: true })
    const invoices = alice.objects(Invoice).query()

    const { artifact, version } = await alice.artifacts.create({
      kind: "page",
      title: "Open",
      files: [await put("index.html", "<!doctype html><title>Open</title><p>Open</p>")],
      queries: {
        largest: invoices
          .where((invoice) => invoice.p.status.eq("open"))
          .orderBy(Invoice.p.amount, "desc")
          .limit(50),
        statuses: { query: invoices, facets: [{ property: Invoice.p.status, limit: 10 }] },
      },
    })

    expect(version.files.map((file) => file.path)).toEqual([
      "index.html",
      "queries/largest.json",
      "queries/statuses.json",
    ])
    expect(await alice.artifacts.query(artifact.id, "largest")).toMatchObject({
      kind: "objects",
      total: 2,
    })
    expect(await alice.artifacts.query(artifact.id, "statuses")).toMatchObject({
      kind: "facets",
      facets: [{ propertyId: "status", buckets: [{ value: "open", count: 2 }] }],
    })
  })

  // Guard proof: skip the `files.some` check in contentFiles; the version then holds the file the
  // caller gave and the query, at one path, and is refused for that instead.
  test("checks them as query files, and refuses a name that is also a file", async () => {
    const { as, put } = setup()
    const alice = as("alice")
    const invoices = alice.objects(Invoice).query()
    const files = [await put("index.html", "<!doctype html><title>Open</title><p>Open</p>")]

    await expectRefused(
      alice.artifacts.create({
        kind: "page",
        title: "Open",
        files,
        queries: { paged: invoices.page({ pageSize: 10 }) },
      }),
      '[Sixb] queries/paged.json: $.kind: "page" is not allowed in an artifact\'s query: Sixb pages the result for each reader; bound the query with "limit" instead.'
    )

    await expectRefused(
      alice.artifacts.create({
        kind: "page",
        title: "Open",
        files: [...files, await put("queries/open.json", JSON.stringify(start))],
        queries: { open: invoices },
      }),
      "[Sixb] 'queries/open.json' is both a file and a query; give it once."
    )
  })
})
