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

  test("skips writing when there is no ontology directory", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-type-manifest-empty-"))
    tempDirs.push(projectRoot)

    const result = await generateOntologyTypeManifest({ projectRoot })

    expect(result.skipped).toBe(true)
    expect(result.written).toBe(false)
    expect(result.entries).toEqual([])
  })
})
