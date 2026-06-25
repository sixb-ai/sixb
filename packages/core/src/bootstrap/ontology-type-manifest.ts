import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { OntologyDocumentInput } from "../ontology/registry"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import { RuntimeError } from "../runtime/errors"

const moduleExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

export interface OntologyTypeManifestEntry {
  readonly objectTypeId: string
  readonly modulePath: string
  readonly exportName: string
  readonly typeExpression: string
}

export interface OntologyTypeManifestDiscovery {
  readonly entries: readonly OntologyTypeManifestEntry[]
  readonly moduleCount: number
}

export interface GenerateOntologyTypeManifestOptions {
  readonly projectRoot: string
  readonly outFile?: string
}

export interface GenerateOntologyTypeManifestResult extends OntologyTypeManifestDiscovery {
  readonly path: string
  readonly written: boolean
  readonly skipped: boolean
}

export async function discoverOntologyTypeManifest(
  projectRoot: string
): Promise<OntologyTypeManifestDiscovery> {
  const resolvedProjectRoot = resolve(projectRoot)
  const ontologyDir = join(resolvedProjectRoot, "ontology")
  const modulePaths = await listModuleFiles(ontologyDir)
  const entries = new Map<string, OntologyTypeManifestEntry>()
  const seenObjectTypes = new Set<unknown>()

  for (const modulePath of modulePaths) {
    const moduleSpecifier = toGeneratedModuleSpecifier({
      fromDir: join(resolvedProjectRoot, ".sixb", "types"),
      modulePath,
    })
    const moduleNamespace = await loadOntologyModule({
      modulePath,
      projectRoot: resolvedProjectRoot,
    })

    for (const [exportName, exportedValue] of Object.entries(moduleNamespace)) {
      collectManifestEntries({
        exportedValue,
        exportName,
        modulePath,
        moduleSpecifier,
        entries,
        seenObjectTypes,
      })
    }
  }

  return {
    entries: [...entries.values()].sort((a, b) => a.objectTypeId.localeCompare(b.objectTypeId)),
    moduleCount: modulePaths.length,
  }
}

export async function generateOntologyTypeManifest(
  options: GenerateOntologyTypeManifestOptions
): Promise<GenerateOntologyTypeManifestResult> {
  const projectRoot = resolve(options.projectRoot)
  const outFile = resolve(projectRoot, options.outFile ?? join(".sixb", "types", "ontology.d.ts"))
  const discovery = await discoverOntologyTypeManifest(projectRoot)

  if (discovery.moduleCount === 0) {
    return {
      ...discovery,
      path: outFile,
      written: false,
      skipped: true,
    }
  }

  const content = renderOntologyTypeManifest(discovery.entries)
  await mkdir(dirname(outFile), { recursive: true })
  const written = await writeFileIfChanged(outFile, content)

  return {
    ...discovery,
    path: outFile,
    written,
    skipped: false,
  }
}

function collectManifestEntries(input: {
  readonly exportedValue: unknown
  readonly exportName: string
  readonly modulePath: string
  readonly moduleSpecifier: string
  readonly entries: Map<string, OntologyTypeManifestEntry>
  readonly seenObjectTypes: Set<unknown>
}): void {
  if (isObjectTypeWithPropertyTokens(input.exportedValue)) {
    addManifestEntry({
      objectType: input.exportedValue,
      modulePath: input.modulePath,
      exportName: input.exportName,
      typeExpression: `typeof import(${JSON.stringify(input.moduleSpecifier)})[${JSON.stringify(
        input.exportName
      )}]`,
      entries: input.entries,
      seenObjectTypes: input.seenObjectTypes,
    })
    return
  }

  if (isOntologyDocumentInput(input.exportedValue)) {
    for (const objectType of input.exportedValue.objectTypes) {
      addManifestEntry({
        objectType,
        modulePath: input.modulePath,
        exportName: input.exportName,
        typeExpression: `Extract<(typeof import(${JSON.stringify(
          input.moduleSpecifier
        )})[${JSON.stringify(input.exportName)}])["objectTypes"][number], { id: ${JSON.stringify(
          objectType.id
        )} }>`,
        entries: input.entries,
        seenObjectTypes: input.seenObjectTypes,
      })
    }
    return
  }

  if (Array.isArray(input.exportedValue)) {
    for (const item of input.exportedValue) {
      if (!isObjectTypeWithPropertyTokens(item)) continue
      addManifestEntry({
        objectType: item,
        modulePath: input.modulePath,
        exportName: input.exportName,
        typeExpression: `Extract<(typeof import(${JSON.stringify(
          input.moduleSpecifier
        )})[${JSON.stringify(input.exportName)}])[number], { id: ${JSON.stringify(item.id)} }>`,
        entries: input.entries,
        seenObjectTypes: input.seenObjectTypes,
      })
    }
  }
}

function addManifestEntry(input: {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly modulePath: string
  readonly exportName: string
  readonly typeExpression: string
  readonly entries: Map<string, OntologyTypeManifestEntry>
  readonly seenObjectTypes: Set<unknown>
}): void {
  if (input.seenObjectTypes.has(input.objectType)) {
    return
  }
  input.seenObjectTypes.add(input.objectType)

  const existing = input.entries.get(input.objectType.id)
  const entry: OntologyTypeManifestEntry = {
    objectTypeId: input.objectType.id,
    modulePath: input.modulePath,
    exportName: input.exportName,
    typeExpression: input.typeExpression,
  }

  if (!existing) {
    input.entries.set(input.objectType.id, entry)
    return
  }

  throw new RuntimeError(
    `[Sixb] Duplicate ontology object type id "${input.objectType.id}" while generating `.concat(
      `the type manifest: ${relative(process.cwd(), existing.modulePath)} and `,
      `${relative(process.cwd(), input.modulePath)}.`
    )
  )
}

function renderOntologyTypeManifest(entries: readonly OntologyTypeManifestEntry[]): string {
  const lines = [
    "// This file is auto-generated by Sixb.",
    "// Do not edit this file directly.",
    "",
    'declare module "@sixb/core/ontology" {',
    "  interface SixbObjectTypeMap {",
  ]

  for (const entry of entries) {
    lines.push(`    ${JSON.stringify(entry.objectTypeId)}: ${entry.typeExpression}`)
  }

  lines.push("  }", "}", "", "export {}", "")
  return lines.join("\n")
}

async function writeFileIfChanged(path: string, content: string): Promise<boolean> {
  try {
    const existing = await readFile(path, "utf-8")
    if (existing === content) return false
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }

  await writeFile(path, content, "utf-8")
  return true
}

async function loadOntologyModule(input: {
  readonly modulePath: string
  readonly projectRoot: string
}): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(input.modulePath).href)) as Record<string, unknown>
  } catch (error) {
    const relPath = relative(input.projectRoot, input.modulePath)
    const reason = error instanceof Error ? error.message : String(error)
    throw new RuntimeError(`Failed to load ontology module '${relPath}': ${reason}`)
  }
}

async function listModuleFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as import("node:fs").Dirent[]
  } catch (error) {
    if (isNotFoundError(error)) {
      return []
    }
    throw error
  }

  const files: string[] = []
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of sortedEntries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listModuleFiles(fullPath)))
      continue
    }

    if (!entry.isFile() || !hasSupportedModuleExtension(entry.name)) {
      continue
    }

    files.push(fullPath)
  }

  return files
}

function toGeneratedModuleSpecifier(input: {
  readonly fromDir: string
  readonly modulePath: string
}): string {
  const withoutExtension = stripSupportedModuleExtension(input.modulePath)
  const relativePath = relative(input.fromDir, withoutExtension).split(sep).join("/")
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`
}

function stripSupportedModuleExtension(path: string): string {
  const extension = extname(path)
  return moduleExtensions.has(extension) ? path.slice(0, -extension.length) : path
}

function hasSupportedModuleExtension(fileName: string): boolean {
  return moduleExtensions.has(extname(fileName).toLowerCase())
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isObjectTypeWithPropertyTokens(value: unknown): value is ObjectTypeWithPropertyTokens {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === "string" &&
    Array.isArray(value.properties) &&
    Array.isArray(value.links) &&
    isRecord(value.p)
  )
}

function isOntologyDocumentInput(value: unknown): value is OntologyDocumentInput {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    Array.isArray(value.objectTypes)
  )
}
