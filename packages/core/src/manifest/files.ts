import { posix } from "node:path"

/** What a definitions manifest lists, and the key prefix discovery records each file under. */
export type DefinitionKind =
  | "objectType"
  | "valueType"
  | "action"
  | "connector"
  | "dataset"
  | "group"
  | "instructions"
  | "marking"
  | "membershipPolicy"
  | "pipeline"
  | "projection"
  | "role"
  | "rule"
  | "schedule"
  | "share"
  | "skill"
  | "sync"
  | "tool"
  | "workflow"

/** Which file each discovered definition came from: `definitionKey(kind, id)` → POSIX path. */
export type DefinitionFiles = ReadonlyMap<string, string>

export function definitionKey(kind: DefinitionKind, id: string): string {
  return `${kind}:${id}`
}

/**
 * Records `path` for a definition. A definition an `index` file re-exports is attributed to the
 * file that declares it, whichever discovery reads first.
 */
export function recordDefinitionFile(
  files: Map<string, string>,
  kind: DefinitionKind,
  id: string,
  path: string
): void {
  const key = definitionKey(kind, id)
  const recorded = files.get(key)
  if (recorded === undefined || (isIndexFile(recorded) && !isIndexFile(path))) {
    files.set(key, path)
  }
}

const definitionFilesKey: unique symbol = Symbol("sixb.definitionFiles")

interface DefinitionFilesOwner {
  readonly [definitionFilesKey]?: DefinitionFiles
}

/** Attaches discovery's files to the host it built, for the manifest to read. */
export function registerDefinitionFiles(owner: object, files: DefinitionFiles): void {
  Object.defineProperty(owner, definitionFilesKey, {
    configurable: false,
    enumerable: false,
    value: files,
    writable: false,
  })
}

/** Empty for a host built without discovery, such as one a test constructs directly. */
export function getDefinitionFiles(owner: object): DefinitionFiles {
  return (owner as DefinitionFilesOwner)[definitionFilesKey] ?? new Map()
}

function isIndexFile(path: string): boolean {
  return posix.basename(path).startsWith("index.")
}
