import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSixb, defineConnector, defineObjectType, prop } from "../src"
import { type BundledProjectModule, withProjectModules } from "../src/bootstrap"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sixb-bundled-discovery-"))
  roots.push(root)
  return root
}

function modules(id: string): BundledProjectModule[] {
  return [
    {
      kind: "ontology",
      path: "ontology/item.ts",
      load: async () => ({
        Item: defineObjectType({
          id,
          name: id,
          properties: [prop("id", "string", { required: true, primary: true })],
        }),
      }),
    },
    {
      kind: "connector",
      path: "connectors/service.ts",
      load: async () => ({ service: defineConnector(id, { type: "mock", connect: () => ({}) }) }),
    },
  ]
}

test("bundled inventories stay isolated across overlapping loads and leave source discovery intact", async () => {
  // Replacing AsyncLocalStorage with a shared current-inventory slot breaks the overlapping loads.
  const root = await projectRoot()
  const hosts = await Promise.all(
    ["First", "Second"].map((id) =>
      withProjectModules(root, modules(id), async () => {
        await Promise.resolve()
        return createSixb({ projectRoot: root, ...createTestRuntimeDeps() })
      })
    )
  )
  for (const [index, id] of ["First", "Second"].entries()) {
    expect(hosts[index]?.definitions.ontology.listObjectTypes().map((type) => type.id)).toEqual([
      id,
    ])
    expect(hosts[index]?.definitions.connectors.list().map((definition) => definition.id)).toEqual([
      id,
    ])
  }
  await expect(createSixb({ projectRoot: root, ...createTestRuntimeDeps() })).rejects.toThrow(
    "No ontology found"
  )
})

test("a missing bundled family is empty even when source files exist", async () => {
  // Falling back to the filesystem for an empty bundled family executes this throwing module.
  const root = await projectRoot()
  await mkdir(join(root, "connectors"))
  await writeFile(join(root, "connectors/extra.ts"), 'throw new Error("source must not load")')
  const host = await withProjectModules(root, modules("Item").slice(0, 1), () =>
    createSixb({ projectRoot: root, ...createTestRuntimeDeps() })
  )
  expect(host.definitions.connectors.list()).toEqual([])
})

test("a built context rejects a different project root instead of mixing inventories", async () => {
  const root = await projectRoot()
  await expect(
    withProjectModules(root, modules("Item"), () =>
      createSixb({ projectRoot: join(root, "other"), ...createTestRuntimeDeps() })
    )
  ).rejects.toThrow("Built project discovery is scoped to")
})
