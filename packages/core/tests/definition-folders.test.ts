import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSixb, defineConnector, defineObjectType, prop } from "../src"
import { type BundledProjectModule, withProjectModules } from "../src/bootstrap"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function objectType(id: string) {
  return defineObjectType({
    id,
    name: id,
    properties: [prop("id", "string", { required: true, primary: true })],
  })
}

function connector(id: string) {
  return defineConnector(id, { type: "mock", connect: () => ({}) })
}

test("each definition keeps the folder below its directory that defines it", async () => {
  const root = await mkdtemp(join(tmpdir(), "sixb-definition-folders-"))
  roots.push(root)

  const deal = objectType("Deal")
  const hubspot = connector("hubspot")
  const modules: BundledProjectModule[] = [
    // Barrels sort first and re-export what the files below them define. Keeping the shallowest
    // module instead of the deepest puts both definitions back at the top.
    { kind: "ontology", path: "ontology/index.ts", load: async () => ({ deal }) },
    { kind: "ontology", path: "ontology/sales/crm/deal.ts", load: async () => ({ deal }) },
    {
      kind: "ontology",
      path: "ontology/site.ts",
      load: async () => ({ Site: objectType("Site") }),
    },
    { kind: "connector", path: "connectors/index.ts", load: async () => ({ hubspot }) },
    { kind: "connector", path: "connectors/crm/hubspot.ts", load: async () => ({ hubspot }) },
    {
      kind: "connector",
      path: "connectors/weather.ts",
      load: async () => ({ weather: connector("weather") }),
    },
  ]

  const host = await withProjectModules(root, modules, () =>
    createSixb({ projectRoot: root, ...createTestRuntimeDeps(), connectors: [connector("inline")] })
  )

  const { folders } = host.definitions
  expect(folders.objectTypes?.get("Deal")).toBe("sales/crm")
  expect(folders.objectTypes?.get("Site")).toBeUndefined()
  expect(folders.connectors?.get("hubspot")).toBe("crm")
  expect(folders.connectors?.get("weather")).toBeUndefined()
  // Passed to createSixb() directly, so it was never in a folder.
  expect(folders.connectors?.get("inline")).toBeUndefined()
  // Folders are per family: the same id in another family is a different definition.
  expect(folders.datasets?.get("hubspot")).toBeUndefined()
})
