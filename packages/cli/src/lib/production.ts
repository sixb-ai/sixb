import { stat } from "node:fs/promises"
import { basename, dirname, resolve, sep } from "node:path"
import { type LoadedPario, loadParioFromEntry } from "./loadPario"

export interface RuntimeEntryOptions {
  readonly entry?: string
}

export interface ProductionPaths {
  readonly projectRoot: string
  readonly buildOutdir: string
}

export async function resolveRuntimeEntry(options: RuntimeEntryOptions = {}): Promise<string> {
  const sourceEntry = resolve("pario.config.ts")
  const defaultBuiltEntry = resolve(".pario/dist/pario.config.js")

  if (options.entry) {
    return resolve(options.entry)
  }

  const builtInfo = await stat(defaultBuiltEntry).catch(() => null)
  return builtInfo ? defaultBuiltEntry : sourceEntry
}

export async function loadProductionPario(
  options: RuntimeEntryOptions = {}
): Promise<{ entry: string; pario: LoadedPario; projectRoot: string; buildOutdir: string }> {
  const entry = await resolveRuntimeEntry(options)
  const pario = await loadParioFromEntry(entry)
  const paths = await resolveProductionPaths(entry)

  return {
    entry,
    pario,
    projectRoot: paths.projectRoot,
    buildOutdir: paths.buildOutdir,
  }
}

export async function resolveProductionPaths(entry: string): Promise<ProductionPaths> {
  const resolvedEntry = resolve(entry)
  const projectRoot = resolveProjectRoot(resolvedEntry)
  const defaultBuildOutdir = resolve(projectRoot, ".pario", "dist")

  if (isDefaultBuildEntry(resolvedEntry)) {
    return { projectRoot, buildOutdir: defaultBuildOutdir }
  }

  const entryDir = dirname(resolvedEntry)
  if (await isCustomBuildOutdirEntry(resolvedEntry, entryDir)) {
    return { projectRoot, buildOutdir: entryDir }
  }

  return { projectRoot, buildOutdir: defaultBuildOutdir }
}

export function resolveProjectRoot(entry: string): string {
  const resolvedEntry = resolve(entry)
  const distMarker = `${sep}.pario${sep}dist${sep}`
  const distIndex = resolvedEntry.lastIndexOf(distMarker)

  if (distIndex >= 0) {
    return resolvedEntry.slice(0, distIndex)
  }

  return dirname(resolvedEntry)
}

export function builtAppOutdir(buildOutdir: string): string {
  return resolve(buildOutdir, "app")
}

export function builtAtlasOutdir(buildOutdir: string): string {
  return resolve(buildOutdir, "atlas")
}

export function builtSentinelOutdir(buildOutdir: string): string {
  return resolve(buildOutdir, "sentinel")
}

function isDefaultBuildEntry(entry: string): boolean {
  return entry.includes(`${sep}.pario${sep}dist${sep}`)
}

async function isCustomBuildOutdirEntry(entry: string, entryDir: string): Promise<boolean> {
  if (basename(entry) !== "pario.config.js") {
    return false
  }

  const hasBuiltAtlas = await stat(resolve(entryDir, "atlas"))
    .then((info) => info.isDirectory())
    .catch(() => false)
  const hasBuiltSentinel = await stat(resolve(entryDir, "sentinel"))
    .then((info) => info.isDirectory())
    .catch(() => false)

  return hasBuiltAtlas || hasBuiltSentinel
}
