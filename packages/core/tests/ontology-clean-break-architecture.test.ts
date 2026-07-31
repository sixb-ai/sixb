import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import ts from "typescript"

const workspaceRoot = join(import.meta.dir, "../../..")
const coreSource = join(workspaceRoot, "packages/core/src")

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)))
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path)
  }
  return files
}

async function expectPatternAbsent(files: readonly string[], pattern: RegExp): Promise<void> {
  for (const file of files) {
    const contents = await readFile(file, "utf8")
    expect(contents, relative(workspaceRoot, file)).not.toMatch(pattern)
  }
}

function reservedMutationEventTypes(source: string, fileName = "source.ts"): string[] {
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

function runtimeCompatibilityIdentifiers(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const matches = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && /(?:legacy|compatibility|shadow|dualWrite)/i.test(node.text)) {
      matches.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return [...matches]
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

describe("ontology clean-break architecture", () => {
  test("keeps object and timeseries storage read-only", async () => {
    await expectPatternAbsent(
      [
        join(coreSource, "storage/objects/types.ts"),
        join(coreSource, "storage/timeseries/types.ts"),
      ],
      /apply(?:ObjectUpsert|LinkUpsert|LinkDelete|TelemetryAppended)/
    )

    const rootExports = await readFile(join(coreSource, "index.ts"), "utf8")
    const storageExports = await readFile(join(coreSource, "storage/index.ts"), "utf8")
    expect(rootExports).not.toMatch(/InMemory(?:Object|Timeseries)Storage/)
    expect(storageExports).not.toMatch(/InMemory(?:Object|Timeseries)Storage/)
  })

  test("does not retain superseded provider mutation methods", async () => {
    const providerRoots = [
      join(coreSource, "storage/objects"),
      join(coreSource, "storage/timeseries"),
      join(workspaceRoot, "storage/sqlite/src"),
      join(workspaceRoot, "storage/pg/src"),
    ]
    const files = (await Promise.all(providerRoots.map(typescriptFiles))).flat()
    await expectPatternAbsent(
      files,
      /\bapply(?:ObjectUpsert|ObjectUpsertBatch|LinkUpsert|LinkUpsertBatch|LinkDelete|TelemetryAppended|TelemetryAppendedBatch)\b/
    )
  })

  test("keeps one projection-run lifecycle contract", async () => {
    const roots = [
      join(coreSource, "storage/projection-runs"),
      join(workspaceRoot, "storage/sqlite/src/projection-run-storage.ts"),
      join(workspaceRoot, "storage/pg/src/pg-projection-run-storage.ts"),
      join(workspaceRoot, "packages/projection-worker/src"),
      join(workspaceRoot, "packages/orchestrator/src"),
    ]
    const files = (
      await Promise.all(
        roots.map(async (root) => (root.endsWith(".ts") ? [root] : typescriptFiles(root)))
      )
    ).flat()
    await expectPatternAbsent(
      files,
      /\b(?:startOrReclaimMaterialization|assertMaterializationExecution|updateMaterialization|finishMaterialization|completeTelemetryInput|ProjectionMaterializationRunStorage|ActionMaterializationRunStorage)\b/
    )
  })

  test("keeps EditBatch and Action authoring free of compatibility branches", async () => {
    await expectPatternAbsent(
      [
        join(coreSource, "edits/types.ts"),
        join(coreSource, "edits/recorder.ts"),
        join(coreSource, "actions/builders/define-action.ts"),
      ],
      /\b(?:EditBatchVersion|legacyRunMessage|rejectLegacyRun)\b|readonly version:/
    )
  })

  test("keeps projection workers off runtime object mutation modules", async () => {
    await expectPatternAbsent(
      await typescriptFiles(join(workspaceRoot, "packages/projection-worker/src")),
      /@sixb\/core\/internal\/objects|@sixb\/core\/objects/
    )
  })

  test("keeps one projection authoring entrypoint and no retired link assignment batch", async () => {
    await expectPatternAbsent(
      await typescriptFiles(join(coreSource, "projections")),
      /\bdefine(?:Link|Telemetry)Projection\b/
    )
    await expectPatternAbsent(
      await typescriptFiles(join(coreSource, "objects")),
      /\bsetLinkBatch\b/
    )
  })

  test("keeps reserved mutation events owned by the Materializer", async () => {
    const mutationModules = [
      join(coreSource, "objects"),
      join(coreSource, "actions"),
      join(workspaceRoot, "packages/action-worker/src"),
      join(workspaceRoot, "packages/projection-worker/src"),
    ]
    const files = (await Promise.all(mutationModules.map(typescriptFiles))).flat()
    for (const file of files) {
      const contents = await readFile(file, "utf8")
      expect(reservedMutationEventTypes(contents, file), relative(workspaceRoot, file)).toEqual([])
    }

    const eventsIndex = await readFile(join(coreSource, "events/index.ts"), "utf8")
    expect(eventsIndex).not.toMatch(/build(?:Object|Link)(?:Upsert|Deleted)Event/)
  })

  test("detects reserved event construction even after nested calls", () => {
    expect(
      reservedMutationEventTypes(`
        events.append({ id: makeId(), type: "object.created" })
        events.emit({ id: makeId(), type: "telemetry.appended" })
      `)
    ).toEqual(["object.created", "telemetry.appended"])
  })

  test("keeps ontology writes behind the materialization capability", async () => {
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
    await expectSqlWritesOwnedBy(
      providerFiles,
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ontology_overrides|objects|links|timeseries|timeseries_latest)\b/i,
      ["materialization-writer.ts"]
    )
    await expectSqlWritesOwnedBy(providerFiles, /SET\s+status\s*=\s*'active'/i, [
      "materializations.ts",
    ])
  })

  test("keeps compatibility runtime branches out of ontology mutation paths", async () => {
    const roots = [
      join(coreSource, "materialization"),
      join(coreSource, "materializer"),
      join(coreSource, "storage/ontology"),
      join(workspaceRoot, "packages/action-worker/src"),
      join(workspaceRoot, "packages/projection-worker/src"),
      join(workspaceRoot, "storage/sqlite/src/ontology-storage"),
      join(workspaceRoot, "storage/pg/src/ontology-storage"),
    ]
    const files = (await Promise.all(roots.map(typescriptFiles))).flat()
    for (const file of files) {
      const contents = await readFile(file, "utf8")
      expect(
        runtimeCompatibilityIdentifiers(contents, file),
        relative(workspaceRoot, file)
      ).toEqual([])
    }
  })

  test("keeps deferred CDC and semantic total-size ceilings out of the implementation", async () => {
    const roots = [
      join(coreSource, "materialization"),
      join(coreSource, "materializer"),
      join(coreSource, "storage/ontology"),
      join(workspaceRoot, "packages/projection-worker/src"),
      join(workspaceRoot, "storage/sqlite/src/ontology-storage"),
      join(workspaceRoot, "storage/pg/src/ontology-storage"),
    ]
    const files = (await Promise.all(roots.map(typescriptFiles))).flat()
    await expectPatternAbsent(
      files,
      /\b(?:MaterializationLimits|maxProjectionEntities|SourceDelta|readChanges|tombstone|dualWrite)\b/
    )
  })

  test("keeps rewritten initial schemas free of superseded provenance", async () => {
    const schemas = [
      join(workspaceRoot, "storage/sqlite/src/migrations/001-initial-schema.sql"),
      join(workspaceRoot, "storage/pg/src/migrations/001-initial-schema.sql"),
    ]
    for (const schema of schemas) {
      const contents = await readFile(schema, "utf8")
      expect(contents, relative(workspaceRoot, schema)).not.toMatch(
        /source_event_id|applied_events_objects/
      )
      expect(contents, relative(workspaceRoot, schema)).not.toMatch(
        /CREATE TABLE.*(?:delta|tombstone)/i
      )
    }
  })
})
