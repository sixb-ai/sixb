/**
 * Where each object type's Agent reference doc lives, and which hand-written docs and scripts are
 * mounted next to it.
 *
 * The generated doc of a type mirrors the `ontology/` module that defines it:
 * `billing/invoice.ts` → `billing/invoice.md`. A module that defines several types gets a folder,
 * one doc per type: `billing.ts` → `billing/Invoice.md`, `billing/Customer.md`.
 *
 * Hand-written docs are notes when they sit at a type's doc path or next to a module exporting the
 * type (`billing.md` for every type of `billing.ts`), compared without case. Notes are appended to
 * the doc of each visible type they belong to, so a reader never receives the notes of types it
 * cannot see. Any other hand-written doc is mounted as written, for every reader.
 */

import type { AgentProjectFile } from "../agents/skills"
import { RuntimeError } from "../runtime/errors"
import type { ObjectType } from "./types"

/** Hand-written Markdown under `ontology/`. */
export interface OntologyDoc {
  /** POSIX path relative to `ontology/`. */
  readonly path: string
  readonly contents: string
}

/** The Agent's files under `ontology/`, as createSixb() discovers them. */
export interface OntologyDocsInput {
  /** Each module, by POSIX path relative to `ontology/`, with the object types it exports. */
  readonly modules: readonly { readonly path: string; readonly objectTypeIds: readonly string[] }[]
  readonly docs: readonly OntologyDoc[]
  /** Every file in a `scripts/` directory under `ontology/`, mounted as written. */
  readonly scripts: readonly AgentProjectFile[]
}

/** Paths are POSIX and relative to `ontology/`. */
export interface OntologyDocsCatalog {
  /** Path of the doc generated for this object type. */
  docPathFor(objectTypeId: string): string
  /** The team's notes for this type, appended to its doc. Sorted by path. */
  notesFor(objectTypeId: string): readonly OntologyDoc[]
  /** Hand-written docs that belong to no object type, mounted for every reader. */
  listDocs(): readonly OntologyDoc[]
  listScripts(): readonly AgentProjectFile[]
  /** Whether a link declares any type (`*`) as its target. Readers' views expand it. */
  isWildcardLink(objectTypeId: string, linkId: string): boolean
}

/** Resolve every registered object type's doc path, rejecting two files that would share one. */
export function createOntologyDocsCatalog(input: {
  readonly objectTypes: readonly ObjectType[]
  readonly docs?: OntologyDocsInput
}): OntologyDocsCatalog {
  const modules = input.docs?.modules ?? []
  const scripts = Object.freeze([...(input.docs?.scripts ?? [])])
  // Sandboxes may sit on a case-insensitive filesystem, where `Invoice.md` overwrites `invoice.md`.
  const claimedPaths = new Map<string, string>(
    scripts.map((script) => [script.path.toLowerCase(), `script 'ontology/${script.path}'`])
  )
  const claim = (path: string, owner: string) => {
    const claimedBy = claimedPaths.get(path.toLowerCase())
    if (claimedBy !== undefined) {
      throw new RuntimeError(
        `[Sixb] The ${owner} at 'ontology/${path}' collides with ${claimedBy}, which only differs ` +
          "by case or not at all. Rename one of them."
      )
    }
    claimedPaths.set(path.toLowerCase(), `the ${owner}`)
  }

  const docPathByType = new Map<string, string>()
  // A hand-written doc at a type's doc path, or next to any module that exports the type, is
  // notes for that type. Several types share the notes of a module that exports all of them.
  const typeIdsByNotesPath = new Map<string, Set<string>>()
  const addNotesPath = (path: string, objectTypeIds: readonly string[]) => {
    const typeIds = typeIdsByNotesPath.get(path.toLowerCase()) ?? new Set<string>()
    for (const objectTypeId of objectTypeIds) typeIds.add(objectTypeId)
    typeIdsByNotesPath.set(path.toLowerCase(), typeIds)
  }
  for (const objectType of input.objectTypes) {
    const path = docPathFor(objectType.id, modules)
    claim(path, `doc of object type '${objectType.id}'`)
    docPathByType.set(objectType.id, path)
    addNotesPath(path, [objectType.id])
  }
  for (const module of modules) {
    if (module.objectTypeIds.length > 0) {
      addNotesPath(`${withoutExtension(module.path)}.md`, module.objectTypeIds)
    }
  }

  const notesByType = new Map<string, OntologyDoc[]>()
  const docs: OntologyDoc[] = []
  const docPaths = new Map<string, string>()
  for (const doc of input.docs?.docs ?? []) {
    const sameName = docPaths.get(doc.path.toLowerCase())
    if (sameName !== undefined) {
      throw new RuntimeError(
        `[Sixb] The ontology docs 'ontology/${sameName}' and 'ontology/${doc.path}' only differ ` +
          "by case. Rename one of them."
      )
    }
    docPaths.set(doc.path.toLowerCase(), doc.path)

    const objectTypeIds = typeIdsByNotesPath.get(doc.path.toLowerCase())
    if (objectTypeIds === undefined) {
      docs.push(doc)
      continue
    }
    for (const objectTypeId of objectTypeIds) {
      notesByType.set(objectTypeId, [...(notesByType.get(objectTypeId) ?? []), doc])
    }
  }
  for (const notes of notesByType.values()) notes.sort(byPath)
  Object.freeze(docs)

  const wildcardLinks = new Set(
    input.objectTypes.flatMap((objectType) =>
      objectType.links
        .filter((link) => link.targetObjectTypeId === "*")
        .map((link) => linkKey(objectType.id, link.id))
    )
  )

  return Object.freeze({
    docPathFor: (objectTypeId: string) => {
      const path = docPathByType.get(objectTypeId)
      if (path === undefined) {
        throw new RuntimeError(`[Sixb] Object type '${objectTypeId}' is not registered.`)
      }
      return path
    },
    notesFor: (objectTypeId: string) => notesByType.get(objectTypeId) ?? [],
    listDocs: () => docs,
    listScripts: () => scripts,
    isWildcardLink: (objectTypeId: string, linkId: string) =>
      wildcardLinks.has(linkKey(objectTypeId, linkId)),
  })
}

/**
 * The module that defines a type, among those exporting it: the one named after the type
 * (`email-thread.ts` for `EmailThread`), else any module but an `index`, else the one exporting the
 * fewest types, else the first by path. Re-exporting barrels never take a type from its module.
 */
function docPathFor(objectTypeId: string, modules: OntologyDocsInput["modules"]): string {
  const rank = (module: OntologyDocsInput["modules"][number]) => {
    const name = basename(withoutExtension(module.path))
    return [
      kebabCase(name) === kebabCase(objectTypeId) ? 0 : 1,
      name === "index" ? 1 : 0,
      module.objectTypeIds.length,
    ]
  }
  let owner: OntologyDocsInput["modules"][number] | undefined
  for (const module of modules) {
    if (!module.objectTypeIds.includes(objectTypeId)) continue
    if (owner === undefined || compareRanks(rank(module), rank(owner)) < 0) owner = module
  }

  const fileName = `${objectTypeId.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.md`
  if (owner === undefined) return fileName
  const base = withoutExtension(owner.path)
  return owner.objectTypeIds.length === 1 ? `${base}.md` : `${base}/${fileName}`
}

function compareRanks(left: readonly number[], right: readonly number[]): number {
  for (const [index, value] of left.entries()) {
    const difference = value - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function kebabCase(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replaceAll(/[\s_]+/g, "-")
    .toLowerCase()
}

function withoutExtension(path: string): string {
  return path.replace(/\.[^./]+$/, "")
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

function linkKey(objectTypeId: string, linkId: string): string {
  return JSON.stringify([objectTypeId, linkId])
}

function byPath(left: OntologyDoc, right: OntologyDoc): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}
