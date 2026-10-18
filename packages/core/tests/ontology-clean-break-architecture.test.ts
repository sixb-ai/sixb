import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import ts from "typescript"

// The Materializer is the only writer of Ontology state (src/materializer/README.md): no ingress
// appends the reserved mutation events or writes the ontology tables directly.
const workspaceRoot = join(import.meta.dir, "../../..")
const coreSource = join(workspaceRoot, "packages/core/src")
const reservedEventType = /["'`](?:object|link|telemetry)\./
const materializerAuthorityWrite =
  /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ontology_(?:overrides|object_overrides|link_overrides)|objects|links|timeseries|timeseries_latest)\b/i

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)))
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path)
  }
  return files
}

function reservedMutationEventTypes(source: string, fileName = "source.ts"): string[] {
  // Only files that mention a reserved type string can construct one; skip parsing the rest.
  if (!reservedEventType.test(source)) return []
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const matches: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          propertyName(property.name) === "type" &&
          ts.isStringLiteralLike(property.initializer) &&
          /^(?:object|link|telemetry)\./.test(property.initializer.text)
        ) {
          matches.push(property.initializer.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return matches
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return undefined
}

async function expectSqlWritesOwnedBy(
  files: readonly string[],
  pattern: RegExp,
  allowedBasenames: readonly string[]
): Promise<void> {
  for (const file of files) {
    const contents = await readFile(file, "utf8")
    if (!pattern.test(contents)) continue
    expect(
      allowedBasenames.some((basename) => file.endsWith(`/${basename}`)),
      relative(workspaceRoot, file)
    ).toBe(true)
  }
}

describe("materializer write ownership", () => {
  test("keeps reserved mutation events owned by the Materializer", async () => {
    // The scanner must see a reserved event built inside nested calls, or the scan below passes
    // vacuously.
    expect(
      reservedMutationEventTypes(`
        events.append({ id: makeId(), type: "object.created" })
        events.emit({ id: makeId(), type: "telemetry.appended" })
      `)
    ).toEqual(["object.created", "telemetry.appended"])

    const mutationModules = [
      join(coreSource, "objects"),
      join(coreSource, "actions"),
      join(workspaceRoot, "packages/projection-worker/src"),
    ]
    const files = (await Promise.all(mutationModules.map(typescriptFiles))).flat()
    for (const file of files) {
      const contents = await readFile(file, "utf8")
      expect(reservedMutationEventTypes(contents, file), relative(workspaceRoot, file)).toEqual([])
    }
  })

  test("keeps ontology writes behind the materialization capability", async () => {
    // Remove a table alternative from materializerAuthorityWrite to verify this guard fails.
    for (const statement of [
      "INSERT INTO ontology_overrides",
      "UPDATE ontology_object_overrides",
      "DELETE FROM ontology_link_overrides",
    ]) {
      expect(statement).toMatch(materializerAuthorityWrite)
    }

    const providerFiles = (
      await Promise.all(
        ["storage/sqlite/src", "storage/pg/src"].map((root) =>
          typescriptFiles(join(workspaceRoot, root))
        )
      )
    ).flat()

    await expectSqlWritesOwnedBy(providerFiles, /INSERT\s+INTO\s+ontology_(?:commits|outbox)\b/i, [
      "materializations.ts",
      "materialization-writer.ts",
    ])
    await expectSqlWritesOwnedBy(providerFiles, materializerAuthorityWrite, [
      "materialization-writer.ts",
    ])
    await expectSqlWritesOwnedBy(providerFiles, /SET\s+status\s*=\s*'active'/i, [
      "materializations.ts",
    ])
  })
})
