import { describe, expect, spyOn, test } from "bun:test"
import { runInstanceCli } from "@sixb/cli-core"
import { ObjectQueryPredicateSchema, ObjectQuerySchema } from "../src/schemas/objects"

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
  })

  test("ships examples the API accepts, including each composite predicate", async () => {
    const names = (await cli("objects", "query", "--example", "list")).trim().split(" ")
    expect(names).toEqual(expect.arrayContaining(["and", "not", "in", "exists", "project"]))

    for (const name of names) {
      const example: unknown = JSON.parse(await cli("objects", "query", "--example", name))
      expect({ name, issues: ObjectQuerySchema.safeParse(example).error?.issues }).toEqual({
        name,
        issues: undefined,
      })
    }
  })
})
