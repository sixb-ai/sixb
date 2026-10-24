import { describe, expect, spyOn, test } from "bun:test"
import { runInstanceCli } from "@sixb/cli-core"
import { parseArtifactQuery } from "../../core/src/artifacts/queries"
import {
  ObjectQueryFacetsRequestSchema,
  ObjectQueryPredicateSchema,
  ObjectQueryRequestSchema,
  ObjectQuerySchema,
} from "../src/schemas/objects"

// The sandbox CLI's query help is hand-written for the model. These tests hold it to the schema
// the API enforces, so a shape the help teaches is a shape the API accepts.

async function cli(...args: string[]): Promise<string> {
  let output = ""
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk)
    return true
  })
  try {
    await runInstanceCli({ args, mode: { kind: "local", baseUrl: "" } })
  } finally {
    write.mockRestore()
  }
  return output
}

const QUERY = '{"kind":"start","objectTypeId":"Type"}'
const PREDICATE = '{"op":"eq","propertyId":"status","value":"open"}'

/** Each `{...}` shape on its own help line, with its `<query>`/`<predicate>` holes filled. */
function helpShapes(help: string): unknown[] {
  return help.split("\n").flatMap((line) => {
    const start = line.indexOf("{")
    const end = line.lastIndexOf("}")
    if (!line.startsWith("  ") || start === -1 || end < start) return []
    const shape = line
      .slice(start, end + 1)
      .replace(/<predicate>/g, PREDICATE)
      .replace(/<[a-z|]+>/g, QUERY)
    return [JSON.parse(shape)]
  })
}

describe("sixb objects query help", () => {
  test("teaches every query node and predicate in a shape the API accepts", async () => {
    // Regression proof: write `"items"` as `"predicates"` in QUERY_HELP's and line; it fails here.
    const shapes = helpShapes(await cli("objects", "query", "--help"))
    const kinds = new Set<string>()
    const ops = new Set<string>()

    for (const shape of shapes) {
      const record = shape as { kind?: string; op?: string }
      if (record.kind) {
        expect({ shape, issues: ObjectQuerySchema.safeParse(shape).error?.issues }).toEqual({
          shape,
          issues: undefined,
        })
        kinds.add(record.kind)
      } else {
        expect({
          shape,
          issues: ObjectQueryPredicateSchema.safeParse(shape).error?.issues,
        }).toEqual({
          shape,
          issues: undefined,
        })
        ops.add(String(record.op))
      }
    }

    expect([...kinds].sort()).toEqual(
      [
        "expand",
        "filter",
        "limit",
        "page",
        "project",
        "refs",
        "rerank",
        "set",
        "sort",
        "start",
        "text",
        "traverse",
        "vector",
      ].sort()
    )
    expect([...ops].sort()).toEqual(["and", "contains", "eq", "exists", "in", "not"])
    expect(shapes).toContainEqual({
      op: "eq",
      propertyId: "assignee",
      value: { type: "currentUser" },
    })
  })

  test("ships examples the API accepts, including each composite predicate", async () => {
    const names = (await cli("objects", "query", "--example", "list")).trim().split(" ")
    expect(names).toEqual(expect.arrayContaining(["and", "not", "in", "exists", "mine", "project"]))

    for (const name of names) {
      const example: unknown = JSON.parse(await cli("objects", "query", "--example", name))
      expect({ name, issues: ObjectQuerySchema.safeParse(example).error?.issues }).toEqual({
        name,
        issues: undefined,
      })
    }
  })
})

// Core reads an artifact's query files without the API's schema. These hold the two to the same
// shapes: what the help teaches reads, and what the API refuses is refused.
describe("an artifact's query file", () => {
  const parse = (value: unknown) => parseArtifactQuery("queries/q.json", JSON.stringify(value))

  test("reads every node and predicate the help teaches, but those it refuses", async () => {
    // Regression proof: add "expand" to REFUSED_NODES in core's queries.ts; it fails here.
    const shapes = helpShapes(await cli("objects", "query", "--help"))

    for (const shape of shapes) {
      const record = shape as { kind?: string }
      const node = record.kind
        ? shape
        : { kind: "filter", input: JSON.parse(QUERY), predicate: shape }
      const parsed = parse(node)

      if (record.kind === "page" || record.kind === "vector" || record.kind === "rerank") {
        expect(parsed).toEqual({
          error: expect.stringContaining(`"${record.kind}" is not allowed in an artifact's query`),
        })
      } else {
        expect({ node, parsed }).toEqual({ node, parsed: expect.objectContaining({ at: "$" }) })
      }
    }
  })

  // Regression proof: return early from `only` in core's queries.ts; the forged fields read.
  test("reads the requests the API takes, and refuses what it refuses", () => {
    const query = JSON.parse(QUERY)
    const accepted = [
      { query },
      { query, includeTotal: false },
      { query, facets: [{ propertyId: "status", limit: 10 }] },
    ]
    for (const request of accepted) {
      const schema = "facets" in request ? ObjectQueryFacetsRequestSchema : ObjectQueryRequestSchema
      expect(schema.safeParse(request).success).toBe(true)
      expect(parse(request)).toMatchObject({ at: "$.query" })
    }

    const refused = [
      { query, facets: [{ propertyId: "status", limit: 0 }] },
      { query, facets: [] },
      { query, includeTotal: true, facets: [{ propertyId: "status", limit: 1 }] },
      { query: { ...query, fieldsByObjectType: {} } },
      {
        query: {
          kind: "filter",
          input: query,
          predicate: { ...JSON.parse(PREDICATE), scalarKind: "string" },
        },
      },
      { query: { kind: "limit", input: query, limit: -1 } },
      { query: { kind: "traverse", input: query, linkId: "owner", direction: "sideways" } },
    ]
    for (const request of refused) {
      const schema = "facets" in request ? ObjectQueryFacetsRequestSchema : ObjectQueryRequestSchema
      expect({ request, accepted: schema.safeParse(request).success }).toEqual({
        request,
        accepted: false,
      })
      expect(parse(request)).toEqual({ error: expect.any(String) })
    }
  })
})
