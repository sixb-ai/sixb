import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { OntologyDocumentInput } from "../ontology/registry"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { ValueType } from "../ontology/types"
import { RuntimeError } from "../runtime/errors"

const moduleExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

export interface OntologyTypeManifestEntry {
  readonly objectTypeId: string
  readonly modulePath: string
  readonly exportName: string
  readonly typeExpression: string
}

/** A value type the manifest registers, so a string-only `valueTypeRef("id")` is typed. */
export interface OntologyValueTypeManifestEntry {
  readonly valueTypeId: string
  readonly modulePath: string
  readonly exportName: string
  readonly typeExpression: string
}

export interface OntologyTypeManifestDiscovery {
  readonly entries: readonly OntologyTypeManifestEntry[]
  readonly valueTypeEntries: readonly OntologyValueTypeManifestEntry[]
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
  const valueTypeEntries = new Map<string, OntologyValueTypeManifestEntry>()
  const seen = new Set<unknown>()

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
        valueTypeEntries,
        seen,
      })
    }
  }

  return {
    entries: [...entries.values()].sort((a, b) => a.objectTypeId.localeCompare(b.objectTypeId)),
    valueTypeEntries: [...valueTypeEntries.values()].sort((a, b) =>
      a.valueTypeId.localeCompare(b.valueTypeId)
    ),
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
    // Leave projects without ontology untouched, but clear a previously generated map.
    try {
      await access(outFile)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
      return {
        ...discovery,
        path: outFile,
        written: false,
        skipped: true,
      }
    }
  }

  const content = renderOntologyTypeManifest(discovery)
  await mkdir(dirname(outFile), { recursive: true })
  const written = await writeFileIfChanged(outFile, content)

  return {
    ...discovery,
    path: outFile,
    written,
    skipped: false,
  }
}

/**
 * Mirrors what runtime discovery registers from an `ontology/` module: exported object types and
 * value types, the ones an exported ontology document carries, and those inside exported arrays.
 */
function collectManifestEntries(input: {
  readonly exportedValue: unknown
  readonly exportName: string
  readonly modulePath: string
  readonly moduleSpecifier: string
  readonly entries: Map<string, OntologyTypeManifestEntry>
  readonly valueTypeEntries: Map<string, OntologyValueTypeManifestEntry>
  readonly seen: Set<unknown>
}): void {
  const exported = `(typeof import(${JSON.stringify(input.moduleSpecifier)})[${JSON.stringify(
    input.exportName
  )}])`
  const add = (value: unknown, typeExpression: (id: string) => string): void => {
    if (isObjectTypeWithPropertyTokens(value)) {
      addManifestEntry({
        kind: "object type",
        definition: value,
        entry: {
          objectTypeId: value.id,
          modulePath: input.modulePath,
          exportName: input.exportName,
          typeExpression: typeExpression(value.id),
        },
        idOf: (entry) => entry.objectTypeId,
        entries: input.entries,
        seen: input.seen,
      })
    } else if (isValueType(value)) {
      addManifestEntry({
        kind: "value type",
        definition: value,
        entry: {
          valueTypeId: value.id,
          modulePath: input.modulePath,
          exportName: input.exportName,
          typeExpression: typeExpression(value.id),
        },
        idOf: (entry) => entry.valueTypeId,
        entries: input.valueTypeEntries,
        seen: input.seen,
      })
    }
  }

  if (isOntologyDocumentInput(input.exportedValue)) {
    for (const objectType of input.exportedValue.objectTypes) {
      add(
        objectType,
        (id) => `Extract<${exported}["objectTypes"][number], { id: ${JSON.stringify(id)} }>`
      )
    }
    for (const valueType of input.exportedValue.valueTypes ?? []) {
      add(
        valueType,
        (id) => `Extract<${exported}["valueTypes"][number], { id: ${JSON.stringify(id)} }>`
      )
    }
    return
  }

  if (Array.isArray(input.exportedValue)) {
    for (const item of input.exportedValue) {
      add(item, (id) => `Extract<${exported}[number], { id: ${JSON.stringify(id)} }>`)
    }
    return
  }

  add(
    input.exportedValue,
    () =>
      `typeof import(${JSON.stringify(input.moduleSpecifier)})[${JSON.stringify(input.exportName)}]`
  )
}

function addManifestEntry<TEntry extends { readonly modulePath: string }>(input: {
  readonly kind: "object type" | "value type"
  readonly definition: unknown
  readonly entry: TEntry
  readonly idOf: (entry: TEntry) => string
  readonly entries: Map<string, TEntry>
  readonly seen: Set<unknown>
}): void {
  // The same definition re-exported from several places is one registration.
  if (input.seen.has(input.definition)) {
    return
  }
  input.seen.add(input.definition)

  const id = input.idOf(input.entry)
  const existing = input.entries.get(id)
  if (!existing) {
    input.entries.set(id, input.entry)
    return
  }

  throw new RuntimeError(
    `[Sixb] Duplicate ontology ${input.kind} id "${id}" while generating `.concat(
      `the type manifest: ${relative(process.cwd(), existing.modulePath)} and `,
      `${relative(process.cwd(), input.entry.modulePath)}.`
    )
  )
}

function renderOntologyTypeManifest(discovery: OntologyTypeManifestDiscovery): string {
  const lines = [
    "// This file is auto-generated by Sixb.",
    "// Do not edit this file directly.",
    "",
    'declare module "@sixb/core/ontology" {',
    "  interface SixbObjectTypeMap {",
  ]

  for (const entry of discovery.entries) {
    lines.push(`    ${JSON.stringify(entry.objectTypeId)}: ${entry.typeExpression}`)
  }

  lines.push("  }", "  interface SixbValueTypeMap {")

  for (const entry of discovery.valueTypeEntries) {
    lines.push(`    ${JSON.stringify(entry.valueTypeId)}: ${entry.typeExpression}`)
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

/** Same shape test runtime discovery applies to an exported value type. */
function isValueType(value: unknown): value is ValueType {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    "schema" in value &&
    !Array.isArray(value.properties) &&
    !Array.isArray(value.objectTypes)
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
