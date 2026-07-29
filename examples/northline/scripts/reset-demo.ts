import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { initializeDemoSources } from "../lib/sources/source-state"

const runtimeDirectory = resolve(import.meta.dir, "..", ".sixb")

await rm(runtimeDirectory, { recursive: true, force: true })
await initializeDemoSources()
console.log("[Northline] Demo state reset. Run `bun run dev` to populate Northline Operations.")
