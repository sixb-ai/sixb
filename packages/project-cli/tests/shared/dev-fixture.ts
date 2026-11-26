import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

export async function createDevFixture() {
  const scratch = resolve(import.meta.dir, "../../../..", ".local")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "dev-reload-"))
  await symlink(
    resolve(import.meta.dir, "../../../../packages/app/node_modules"),
    join(root, "node_modules"),
    "dir"
  )
  async function write(path: string, source: string) {
    const target = join(root, path)
    await mkdir(resolve(target, ".."), { recursive: true })
    await writeFile(target, source)
  }
  await write(".sixb/events.log", "")
  await write("lib/value.ts", 'export const value = "first"\n')
  await write("ontology/Thing.ts", objectSource("Thing"))
  await write("actions/report.ts", actionSource())
  await write(
    "datasets/tables.ts",
    `
import { col, defineDataset } from "@sixb/core"
export const source = defineDataset("source", { schema: [col("id", "string")] })
export const target = defineDataset("target", { schema: [col("id", "string")] })
`
  )
  await write("pipelines/copy.ts", pipelineSource("pipeline-first"))
  await write(
    "sixb.config.ts",
    `
import { appendFileSync } from "node:fs"
import { createSixb, InMemoryBroker, InMemoryQueues, InMemoryStorage,
  InMemoryLakeStorage, InMemoryBlobStorage } from "@sixb/core"
import { source } from "./datasets/tables"
const log = (type: string) => appendFileSync(import.meta.dir + "/.sixb/events.log",
  JSON.stringify({ type, pid: process.pid }) + "\\n")
log("start")
class Storage extends InMemoryStorage {
  async close() { log("close") }
}
const lakeStorage = new InMemoryLakeStorage()
await lakeStorage.createDataset(source)
const write = await lakeStorage.beginWrite({ dataset: source, mode: "snapshot" })
await write.writeRows([{ id: "seed" }])
await write.commit({ commitMessage: "seed" })
export const sixb = await createSixb({
  id: "dev-reload", projectRoot: import.meta.dir,
  broker: new InMemoryBroker(), queues: new InMemoryQueues(), storage: new Storage(),
  lakeStorage, blobStorage: new InMemoryBlobStorage(),
})
`
  )
  return { root, write }
}

export function objectSource(id: string) {
  return `import { defineObjectType, prop } from "@sixb/core/ontology"
export const ${id} = defineObjectType({ id: "${id}", name: "${id}",
  properties: [prop("id", "string", { required: true, primary: true })] })\n`
}

export function actionSource(suffix = "") {
  return `import { appendFileSync } from "node:fs"
import { defineAction } from "@sixb/core"
import { value } from "../lib/value"
export const report = defineAction("report").params({}).writeback(async () => {
  appendFileSync(import.meta.dir + "/../.sixb/events.log",
    JSON.stringify({ type: "action", value: value + ${JSON.stringify(suffix)}, pid: process.pid }) + "\\n")
})\n`
}

export function pageSource(text: string) {
  return `export default function Page() { return <h1>${text}</h1> }\n`
}

export function pipelineSource(value: string) {
  return `import { appendFileSync } from "node:fs"
import { definePipeline, definePipelineStep } from "@sixb/core"
import { source, target } from "../datasets/tables"
const step = definePipelineStep("copy").inputs({ source }).output(target).run(async ({ output }) => {
  await output.writeRows([{ id: ${JSON.stringify(value)} }])
  appendFileSync(import.meta.dir + "/../.sixb/events.log",
    JSON.stringify({ type: "pipeline", value: ${JSON.stringify(value)}, pid: process.pid }) + "\\n")
})
export const copy = definePipeline("copy").then(step)\n`
}
