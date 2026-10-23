import { describe, expect, test } from "bun:test"
import type { ArtifactFile, ArtifactRequestErrorCode, AuthorizationContext } from "../src"
import { ArtifactRequestError, defineMarking, defineObjectType, prop, SixbHost } from "../src"
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

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: projectId, ontology: [Invoice], markings: [financial], ...deps })

  const as = (
    id: string,
    options: { readonly views?: readonly string[]; readonly cleared?: boolean } = {}
  ) => {
    const authorization: AuthorizationContext = {
      principal: { type: "user", id },
      groupIds: [],
      roleIds: [],
      grants: { ...emptyGrantIndex(), "view:object": new Set(options.views ?? ["Invoice"]) },
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

    const published = await as("alice").artifacts.create(
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
