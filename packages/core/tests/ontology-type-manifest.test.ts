import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateOntologyTypeManifest } from "../src/bootstrap"

describe("ontology type manifest", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  })

  test("generates an ambient object type map from discovered ontology exports", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-type-manifest-"))
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, "ontology"), { recursive: true })

    await writeFile(
      join(projectRoot, "ontology", "customer.ts"),
      [
        "export const Customer = {",
        '  id: "Customer",',
        '  name: "Customer",',
        "  properties: [],",
        "  links: [],",
        "  p: {},",
        "}",
        "",
        "const Region = {",
        '  id: "Region",',
        '  name: "Region",',
        "  properties: [],",
        "  links: [],",
        "  p: {},",
        "}",
        "",
        "export const AppOntology = {",
        '  id: "app",',
        '  version: "1.0.0",',
        "  objectTypes: [Region],",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    )

    const result = await generateOntologyTypeManifest({ projectRoot })
    const content = await readFile(result.path, "utf-8")

    expect(result.skipped).toBe(false)
    expect(result.written).toBe(true)
    expect(result.entries.map((entry) => entry.objectTypeId)).toEqual(["Customer", "Region"])
    expect(content).toContain('"Customer": typeof import("../../ontology/customer")["Customer"]')
    expect(content).toContain(
      '"Region": Extract<(typeof import("../../ontology/customer")["AppOntology"])'
    )
    expect(content).toContain('declare module "@sixb/core/ontology"')
  })

  test("registers value types from the same exports runtime discovery registers", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-type-manifest-value-types-"))
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, "ontology"), { recursive: true })

    await writeFile(
      join(projectRoot, "ontology", "values.ts"),
      [
        'export const Azimuth = { id: "Azimuth", name: "Azimuth", schema: "double" }',
        'const Money = { id: "Money", name: "Money", schema: "decimal" }',
        'const Rate = { id: "Rate", name: "Rate", schema: "double" }',
        "export const Shared = [Money]",
        "export const AppOntology = {",
        '  id: "app",',
        '  version: "1.0.0",',
        "  objectTypes: [],",
        "  valueTypes: [Rate],",
        "}",
        // Re-exporting a definition registers it once.
        "export const AzimuthAlias = Azimuth",
        "",
      ].join("\n"),
      "utf-8"
    )

    const result = await generateOntologyTypeManifest({ projectRoot })
    const content = await readFile(result.path, "utf-8")

    expect(result.valueTypeEntries.map((entry) => entry.valueTypeId)).toEqual([
      "Azimuth",
      "Money",
      "Rate",
    ])
    expect(content).toContain("interface SixbValueTypeMap {")
    expect(content).toContain('"Azimuth": typeof import("../../ontology/values")["Azimuth"]')
    expect(content).toContain(
      '"Money": Extract<(typeof import("../../ontology/values")["Shared"])[number], { id: "Money" }>'
    )
    expect(content).toContain(
      '"Rate": Extract<(typeof import("../../ontology/values")["AppOntology"])["valueTypes"][number], { id: "Rate" }>'
    )
  })

  test("rejects two value types exported under the same id", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-type-manifest-duplicate-value-type-"))
    tempDirs.push(projectRoot)
    await mkdir(join(projectRoot, "ontology"), { recursive: true })
    await writeFile(
      join(projectRoot, "ontology", "a.ts"),
      'export const Money = { id: "Money", name: "Money", schema: "decimal" }'
    )
    await writeFile(
      join(projectRoot, "ontology", "b.ts"),
      'export const Money = { id: "Money", name: "Money", schema: "double" }'
    )

    await expect(generateOntologyTypeManifest({ projectRoot })).rejects.toThrow(
      '[Sixb] Duplicate ontology value type id "Money"'
    )
  })

  test("skips writing when there is no ontology directory", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-type-manifest-empty-"))
    tempDirs.push(projectRoot)

    const result = await generateOntologyTypeManifest({ projectRoot })

    expect(result.skipped).toBe(true)
    expect(result.written).toBe(false)
    expect(result.entries).toEqual([])
    expect(await Bun.file(result.path).exists()).toBe(false)
  })

  // Guard: restore the unconditional moduleCount === 0 early return in the generator.
  // Both deletion cases then retain the removed Customer import and fail.
  test.each([
    "file",
    "directory",
  ] as const)("clears the existing manifest after deleting the last ontology %s", async (target) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-type-manifest-deleted-"))
    tempDirs.push(projectRoot)
    const ontologyDir = join(projectRoot, "ontology")
    const modulePath = join(ontologyDir, "customer.ts")
    await mkdir(ontologyDir)
    await writeFile(
      modulePath,
      'export const Customer = { id: "Customer", name: "Customer", properties: [], links: [], p: {} }'
    )

    const initial = await generateOntologyTypeManifest({ projectRoot })
    expect(await readFile(initial.path, "utf-8")).toContain('"Customer": typeof import(')
    await rm(target === "file" ? modulePath : ontologyDir, { recursive: true })

    const result = await generateOntologyTypeManifest({ projectRoot })
    const content = await readFile(result.path, "utf-8")
    expect(content).not.toContain("Customer")
    expect(content).not.toContain("typeof import(")
    expect(content).toContain('declare module "@sixb/core/ontology"')
    expect(content).toContain("interface SixbObjectTypeMap")
    expect(result.entries).toEqual([])
    expect(result.written).toBe(true)
    expect(result.skipped).toBe(false)

    const unchanged = await generateOntologyTypeManifest({ projectRoot })
    expect(unchanged.written).toBe(false)
    expect(await readFile(result.path, "utf-8")).toBe(content)
  })
})
