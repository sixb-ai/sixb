/**
 * Markdown reference docs for the object types one reader can see, rendered from that reader's
 * authorized ontology view. Output is deterministic: the same view renders the same bytes.
 */

import type { ActionDescriptor, ActionParamDescriptor } from "../actions/descriptor"
import type { AgentProjectFile } from "../agents/skills"
import type { OntologyDoc, OntologyDocsCatalog } from "./docs"
import {
  type PropertyQueryOperator,
  resolvePropertyQueryCapabilities,
  resolveQuerySchema,
} from "./query-capabilities"
import type { ObjectLink, ObjectType, PrimitiveSchema, Property, Schema, ValueType } from "./types"

export interface RenderOntologyDocsInput {
  readonly catalog: OntologyDocsCatalog
  /** The object types the reader can see, as its authorized ontology view lists them. */
  readonly objectTypes: readonly ObjectType[]
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  /** The actions the reader can request on objects of this type. */
  readonly actionsFor: (objectType: ObjectType) => readonly ActionDescriptor[]
  /**
   * Marked properties the reader is not cleared for. Like the ontology API, docs still list them,
   * flagged, so the agent can say the information exists; their values cannot be read or queried.
   */
  readonly restrictedPropertyIds?: (objectTypeId: string) => ReadonlySet<string> | undefined
}

export interface OntologyDocsIndexEntry {
  /** POSIX path relative to the ontology directory; a scripts directory ends with `/`. */
  readonly path: string
  readonly summary: string
}

export interface RenderedOntologyDocs {
  /** Files to install, by POSIX path relative to the ontology directory. */
  readonly files: readonly AgentProjectFile[]
  /** One entry per doc and per scripts directory, sorted by path. */
  readonly index: readonly OntologyDocsIndexEntry[]
}

const MAX_SUMMARY_LENGTH = 120
const EXACT: readonly PropertyQueryOperator[] = ["eq", "neq", "in", "exists"]
const RANGE: readonly PropertyQueryOperator[] = ["lt", "lte", "gt", "gte"]
const ORDERED_SCHEMAS: ReadonlySet<PrimitiveSchema> = new Set([
  "integer",
  "double",
  "decimal",
  "date",
  "timestamp",
])
/** A period that ends "e.g." or "i.e." does not end the sentence. */
const ABBREVIATION_END_RE = /\b(?:e\.g|i\.e|etc|vs|cf)\.$/i

/** Render one doc per visible type, then the team's other docs and scripts. */
export function renderOntologyDocs(input: RenderOntologyDocsInput): RenderedOntologyDocs {
  const objectTypes = input.objectTypes
  const objectTypesById = new Map(objectTypes.map((objectType) => [objectType.id, objectType]))
  const docs = [
    ...objectTypes.map((objectType) => ({
      path: input.catalog.docPathFor(objectType.id),
      contents: renderObjectTypeDoc({
        ...input,
        objectType,
        objectTypes,
        objectTypesById,
        restricted: input.restrictedPropertyIds?.(objectType.id) ?? new Set(),
      }),
      summary: typeSummary(objectType),
    })),
    ...input.catalog.listDocs().map((doc) => ({
      path: doc.path,
      contents: doc.contents,
      summary: firstHeading(doc.contents) ?? "",
    })),
  ]
  const scripts = input.catalog.listScripts()
  const scriptDirectories = [...new Set(scripts.map((script) => scriptsDirectoryOf(script.path)))]

  return Object.freeze({
    files: Object.freeze(
      [...docs.map(({ path, contents }) => ({ path, contents })), ...scripts].sort(byPath)
    ),
    index: Object.freeze(
      [
        ...docs.map(({ path, summary }) => ({ path, summary })),
        ...scriptDirectories.map((path) => ({ path, summary: "Scripts" })),
      ].sort(byPath)
    ),
  })
}

function renderObjectTypeDoc(
  input: RenderOntologyDocsInput & {
    readonly objectType: ObjectType
    readonly objectTypes: readonly ObjectType[]
    readonly objectTypesById: ReadonlyMap<string, ObjectType>
    readonly restricted: ReadonlySet<string>
  }
): string {
  const { objectType, restricted } = input
  const sections = [
    objectType.name === objectType.id
      ? `# ${objectType.id}`
      : `# ${objectType.id} — ${oneLine(objectType.name)}`,
    objectType.description?.trim(),
    objectType.extends === undefined ? undefined : `Extends \`${objectType.extends}\`.`,
    renderProperties(objectType, input.valueTypesById, restricted),
    renderVectorProfiles(objectType, restricted),
    renderLinks(objectType, input.objectTypesById, input.catalog),
    renderIncomingLinks(objectType, input.objectTypes, input.catalog),
    renderActions(input.actionsFor(objectType), input.valueTypesById),
    renderNotes(input.catalog.notesFor(objectType.id)),
  ]
  return `${sections.filter((section) => section !== undefined && section !== "").join("\n\n")}\n`
}

function renderProperties(
  objectType: ObjectType,
  valueTypesById: ReadonlyMap<string, ValueType>,
  restricted: ReadonlySet<string>
): string | undefined {
  if (objectType.properties.length === 0) return undefined
  const anyRestricted = objectType.properties.some((property) => restricted.has(property.id))
  return [
    "## Properties",
    "",
    ...(anyRestricted
      ? ["Restricted properties: this user is not cleared to read or query their values.", ""]
      : []),
    table(
      ["Property", "Type", "Query", "Description"],
      objectType.properties.map((property) => [
        code(property.id),
        withFlags(schemaLabel(property.schema, valueTypesById), [
          ...(property.primary ? ["primary key"] : []),
          ...(property.required && !property.primary ? ["required"] : []),
          ...(property.nullable ? ["nullable"] : []),
          ...(property.mode === "telemetry" ? ["telemetry"] : []),
          ...(restricted.has(property.id) ? ["restricted"] : []),
        ]),
        restricted.has(property.id) ? "—" : queryLabel(property, valueTypesById),
        property.description ?? "",
      ])
    ),
  ].join("\n")
}

function queryLabel(property: Property, valueTypesById: ReadonlyMap<string, ValueType>): string {
  const capabilities = resolvePropertyQueryCapabilities(property, valueTypesById)
  const schema = resolveQuerySchema(property.schema, valueTypesById)
  const meaningful = schema === undefined ? new Set() : meaningfulOperators(schema)
  const operators = capabilities.operators.filter((operator) => meaningful.has(operator))
  const labels = [
    ...(operators.length === 0 ? [] : [`filter: ${operators.join(", ")}`]),
    ...(capabilities.sortable ? ["sort"] : []),
    ...(capabilities.text ? ["text"] : []),
    ...(capabilities.facet ? ["facet"] : []),
  ]
  return labels.length === 0 ? "—" : labels.join("; ")
}

/**
 * The predicates worth suggesting for a schema: the engine also accepts ranges over strings and
 * enums, and substring matches, which rarely answer a question about this kind of value.
 */
function meaningfulOperators(schema: Schema): ReadonlySet<PropertyQueryOperator> {
  if (typeof schema === "string") {
    return new Set(ORDERED_SCHEMAS.has(schema) ? [...EXACT, ...RANGE] : EXACT)
  }
  if (schema.type === "enum") return new Set(EXACT)
  if (schema.type === "array" || schema.type === "map") return new Set(["contains"])
  return new Set()
}

function renderVectorProfiles(
  objectType: ObjectType,
  restricted: ReadonlySet<string>
): string | undefined {
  // Searching a profile admits each of its sources like a filter would: one restricted source
  // makes the search fail for this user, so the profile is left out.
  const profiles = Object.entries(objectType.search?.vectors ?? {}).filter(([, profile]) =>
    profile.source.every((propertyId) => !restricted.has(propertyId))
  )
  if (profiles.length === 0) return undefined
  return [
    "## Vector search profiles",
    "",
    table(
      ["Profile", "Sources"],
      profiles
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, profile]) => [code(name), profile.source.map(code).join(", ")])
    ),
  ].join("\n")
}

function renderLinks(
  objectType: ObjectType,
  objectTypesById: ReadonlyMap<string, ObjectType>,
  catalog: OntologyDocsCatalog
): string | undefined {
  if (objectType.links.length === 0) return undefined
  return [
    "## Links",
    "",
    table(
      ["Link", "Target", "Cardinality", "Description", "Target description"],
      objectType.links.map((link) => {
        // A reader's view expands `*` into every type it can see; the doc keeps the declaration.
        const targets = catalog.isWildcardLink(objectType.id, link.id) ? ["*"] : linkTargets(link)
        return [
          code(link.id),
          targets.map(code).join(", "),
          link.cardinality ?? "many",
          link.description ?? "",
          targets
            .map((targetId) => firstSentence(objectTypesById.get(targetId)?.description))
            .filter((description) => description !== undefined)
            .join(" "),
        ]
      })
    ),
  ].join("\n")
}

function renderIncomingLinks(
  objectType: ObjectType,
  objectTypes: readonly ObjectType[],
  catalog: OntologyDocsCatalog
): string | undefined {
  const incoming = objectTypes.flatMap((source) =>
    source.links
      .filter(
        (link) =>
          !catalog.isWildcardLink(source.id, link.id) && linkTargets(link).includes(objectType.id)
      )
      .map((link) => [
        code(source.id),
        code(link.id),
        link.cardinality ?? "many",
        link.description ?? "",
      ])
  )
  if (incoming.length === 0) return undefined
  return [
    "## Incoming links",
    "",
    "Declared on other types; traverse them with direction `incoming`.",
    "",
    table(["From", "Link", "Cardinality", "Description"], incoming),
  ].join("\n")
}

function renderActions(
  actions: readonly ActionDescriptor[],
  valueTypesById: ReadonlyMap<string, ValueType>
): string | undefined {
  if (actions.length === 0) return undefined
  return [
    "## Actions",
    ...[...actions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((action) => {
        const params = Object.entries(action.params)
        return [
          `### ${code(action.id)}`,
          ...(action.description?.trim() ? [action.description.trim()] : []),
          params.length === 0
            ? "No parameters."
            : table(
                ["Param", "Type", "Required", "Description"],
                params.map(([id, param]) => [
                  code(id),
                  paramTypeLabel(param, valueTypesById),
                  param.required ? "yes" : "no",
                  param.description ?? "",
                ])
              ),
        ].join("\n\n")
      }),
  ].join("\n\n")
}

function renderNotes(notes: readonly OntologyDoc[]): string | undefined {
  const contents = notes.map((note) => note.contents.trim()).filter(Boolean)
  return contents.length === 0 ? undefined : `## Project notes\n\n${contents.join("\n\n")}`
}

function paramTypeLabel(
  param: ActionParamDescriptor,
  valueTypesById: ReadonlyMap<string, ValueType>
): string {
  return withFlags(schemaLabel(param.schema, valueTypesById), param.nullable ? ["nullable"] : [])
}

function withFlags(label: string, flags: readonly string[]): string {
  return flags.length === 0 ? label : `${label} (${flags.join(", ")})`
}

type DescribedSchema = ActionParamDescriptor["schema"]

function schemaLabel(
  schema: DescribedSchema,
  valueTypesById: ReadonlyMap<string, ValueType>,
  seen: ReadonlySet<string> = new Set()
): string {
  if (typeof schema === "string") return schema
  switch (schema.type) {
    case "enum":
      return `one of ${schema.values.map((value) => code(String(value))).join(", ")}`
    case "array":
      return `array of ${schemaLabel(schema.items, valueTypesById, seen)}`
    case "map":
      return `map of string to ${schemaLabel(schema.valueSchema, valueTypesById, seen)}`
    case "object":
      return `object { ${Object.entries(schema.properties)
        .map(
          ([id, field]) =>
            `${id}${field.required ? "" : "?"}: ${schemaLabel(field.schema, valueTypesById, seen)}`
        )
        .join(", ")} }`
    case "objectRef":
      return `reference to ${code(schema.objectTypeId)}`
    case "valueTypeRef": {
      const resolved = valueTypesById.get(schema.valueTypeId)?.schema
      if (resolved === undefined || seen.has(schema.valueTypeId)) return schema.valueTypeId
      const nested = new Set(seen).add(schema.valueTypeId)
      return `${schema.valueTypeId} (${schemaLabel(resolved, valueTypesById, nested)})`
    }
  }
}

function linkTargets(link: ObjectLink): readonly string[] {
  // A link to any type (`*`) is not about this one; it has no incoming entry.
  return (
    Array.isArray(link.targetObjectTypeId) ? link.targetObjectTypeId : [link.targetObjectTypeId]
  ).filter((targetId) => targetId !== "*")
}

function scriptsDirectoryOf(path: string): string {
  const segments = path.split("/")
  return `${segments.slice(0, segments.indexOf("scripts") + 1).join("/")}/`
}

function typeSummary(objectType: ObjectType): string {
  const description = firstSentence(objectType.description)
  if (description !== undefined) return `${objectType.id}: ${description}`
  return objectType.name === objectType.id ? objectType.id : `${objectType.id}: ${objectType.name}`
}

function firstSentence(text: string | undefined): string | undefined {
  const normalized = text?.replaceAll(/\s+/g, " ").trim()
  if (!normalized) return undefined
  for (const match of normalized.matchAll(/[.!?](?=\s|$)/g)) {
    const sentence = normalized.slice(0, match.index + 1)
    if (!ABBREVIATION_END_RE.test(sentence)) return truncate(sentence)
  }
  return truncate(normalized)
}

function firstHeading(markdown: string): string | undefined {
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1]
  return heading === undefined ? undefined : truncate(heading)
}

function truncate(text: string): string {
  return text.length <= MAX_SUMMARY_LENGTH ? text : `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n")
}

function cell(text: string): string {
  return oneLine(text).replaceAll("|", "\\|")
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim()
}

function code(text: string): string {
  return `\`${text}\``
}

function byPath(left: { readonly path: string }, right: { readonly path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}
