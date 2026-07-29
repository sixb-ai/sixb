import { access, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createNorthlineScenario } from "../scenario/create-scenario"
import { createScenarioClock } from "../scenario/scenario-clock"
import { businessStateSchema, controlsStateSchema, fieldServiceStateSchema } from "./contracts"
import { AtomicJsonStore, sourceDirectory } from "./file-store"

export const sourcePaths = {
  business: join(sourceDirectory(), "business-system.json"),
  fieldService: join(sourceDirectory(), "field-service.json"),
  controls: join(sourceDirectory(), "building-controls.json"),
} as const

export const businessStore = new AtomicJsonStore(sourcePaths.business, businessStateSchema)
export const fieldServiceStore = new AtomicJsonStore(
  sourcePaths.fieldService,
  fieldServiceStateSchema
)
export const controlsStore = new AtomicJsonStore(sourcePaths.controls, controlsStateSchema)

export async function initializeDemoSources(anchor = new Date()): Promise<boolean> {
  const existing = await Promise.all(Object.values(sourcePaths).map(fileExists))
  if (existing.every(Boolean)) return false
  if (existing.some(Boolean)) {
    throw new Error(
      "[NorthlineSource] Demo source state is incomplete. Run `bun run demo:reset` to recreate it."
    )
  }

  const scenario = createNorthlineScenario(createScenarioClock(anchor))
  await mkdir(sourceDirectory(), { recursive: true })
  await Promise.all([
    businessStore.write(scenario.business),
    fieldServiceStore.write(scenario.fieldService),
    controlsStore.write(scenario.controls),
  ])
  return true
}

export async function resetDemoSources(anchor = new Date()): Promise<void> {
  await rm(sourceDirectory(), { recursive: true, force: true })
  await initializeDemoSources(anchor)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
