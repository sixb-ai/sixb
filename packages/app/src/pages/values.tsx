/**
 * Recorded values — a run's input and output, an action's params — drawn as a readable tree.
 *
 * A value renders from the schema it was declared with, never from its shape: a record that happens
 * to look like `{ objectTypeId, primaryId }` is a record, and a string that looks like a date is a
 * string. Two states stay distinct. With no schema the value is open (output nobody declared), and
 * object references and files are recognized by shape, the only signal there is. With a schema whose
 * node cannot be read (an unresolved `valueTypeRef`, a field it does not name), the value is drawn
 * generically and its type is never guessed.
 */
import { listObjectTypesOptions } from "@sixb/client/hooks"
import type { UserRef } from "@sixb/core"
import { type FileRef, fileNameFor, isFileRef } from "@sixb/core/blob-storage"
import {
  defineMessages,
  type MessageTree,
  plural,
  type Translation,
  useLocale,
} from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { Box, Download, Eye, FileIcon, UserRound } from "lucide-react"
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react"
import { CopyButton } from "./section-ui"

export const en = {
  structured: "Structured",
  raw: "Raw",
  empty: "Nothing recorded",
  emptyList: "Empty list",
  emptyRecord: "No fields",
  items: (count: number) => plural("en", count, { one: "1 item", other: `${count} items` }),
  fields: (count: number) => plural("en", count, { one: "1 field", other: `${count} fields` }),
  user: "user",
  view: "View",
  download: "Download",
  showMore: "Show more",
  showLess: "Show less",
  file: "File",
} satisfies MessageTree

export const fr: Translation<typeof en> = {
  structured: "Structuré",
  raw: "Brut",
  empty: "Rien d’enregistré",
  emptyList: "Liste vide",
  emptyRecord: "Aucun champ",
  items: (count: number) => plural("fr", count, { one: "1 élément", other: `${count} éléments` }),
  fields: (count: number) => plural("fr", count, { one: "1 champ", other: `${count} champs` }),
  user: "utilisateur",
  view: "Voir",
  download: "Télécharger",
  showMore: "Voir plus",
  showLess: "Voir moins",
  file: "Fichier",
}

const useValueMessages = defineMessages<typeof en>({ en, fr }).useMessages

/** Value type id → schema, collected from the declarations the browser can read. */
export type ValueTypeSchemas = ReadonlyMap<string, unknown>

/** One position in a schema, with the value types that resolve refs below it. */
export interface ValueSchema {
  readonly schema: unknown
  readonly valueTypes: ValueTypeSchemas
}

type ValueSchemaNode =
  | { readonly kind: "unknown" | "fileRef" | "userRef" | "primitive" }
  | { readonly kind: "objectRef"; readonly objectTypeId: string }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, ValueSchema>> }
  | { readonly kind: "array"; readonly items: ValueSchema }
  | { readonly kind: "map"; readonly values: ValueSchema }

const noValueTypes: ValueTypeSchemas = new Map()
const unknownSchema: ValueSchema = { schema: undefined, valueTypes: noValueTypes }
const primitives = new Set([
  "string",
  "uuid",
  "integer",
  "double",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "enum",
])

export function valueSchema(
  schema: unknown,
  valueTypes: ValueTypeSchemas = noValueTypes
): ValueSchema {
  return { schema, valueTypes }
}

/**
 * Wraps a record of named field schemas, such as action params or workflow inputs, as one
 * `object` schema. Each entry is a bare schema or a field config carrying `schema`.
 */
export function fieldRecordSchema(fields: Readonly<Record<string, unknown>>): unknown {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(fields).map(([id, field]) => [
        id,
        { schema: isRecord(field) && "schema" in field ? field.schema : field },
      ])
    ),
  }
}

/**
 * The value types a page can resolve: those the project's object types carry inline, plus any in
 * `extraSchemas` (workflow inputs, action params). Keep `extraSchemas` referentially stable.
 */
export function useValueTypes(extraSchemas: readonly unknown[]): ValueTypeSchemas {
  const objectTypes = useQuery({ ...listObjectTypesOptions(), retry: false }).data
  return useMemo(() => {
    const schemas = (objectTypes ?? []).flatMap((objectType) => [
      ...objectType.properties.map((property) => property.schema),
      ...(objectType.links ?? []).flatMap((link) =>
        (link.properties ?? []).map((property) => property.schema)
      ),
      ...(objectType.actions ?? []).flatMap((action) => action.params.map((param) => param.schema)),
    ])
    return collectValueTypeSchemas([...schemas, ...extraSchemas])
  }, [objectTypes, extraSchemas])
}

// A `valueTypeRef` declared with `valueTypeRef(MyValueType)` carries its schema inline; one
// declared by id alone stays unresolved here and draws as unknown.
function collectValueTypeSchemas(schemas: readonly unknown[]): Map<string, unknown> {
  const collected = new Map<string, unknown>()
  const visit = (schema: unknown): void => {
    if (!isRecord(schema)) return
    if (schema.type === "valueTypeRef") {
      if (
        typeof schema.valueTypeId === "string" &&
        schema._resolved !== undefined &&
        !collected.has(schema.valueTypeId)
      ) {
        collected.set(schema.valueTypeId, schema._resolved)
        visit(schema._resolved)
      }
    } else if (schema.type === "object" && isRecord(schema.properties)) {
      for (const field of Object.values(schema.properties)) {
        if (isRecord(field)) visit(field.schema)
      }
    } else if (schema.type === "array") visit(schema.items)
    else if (schema.type === "map") visit(schema.valueSchema)
  }
  for (const schema of schemas) visit(schema)
  return collected
}

function describe({ schema, valueTypes }: ValueSchema): ValueSchemaNode {
  let resolved = schema
  const seen = new Set<string>()
  while (isRecord(resolved) && resolved.type === "valueTypeRef") {
    const id = resolved.valueTypeId
    if (typeof id !== "string" || seen.has(id)) return { kind: "unknown" }
    seen.add(id)
    resolved = resolved._resolved !== undefined ? resolved._resolved : valueTypes.get(id)
  }
  if (resolved === "fileRef" || resolved === "userRef") return { kind: resolved }
  if (typeof resolved === "string") {
    return { kind: primitives.has(resolved) ? "primitive" : "unknown" }
  }
  if (!isRecord(resolved)) return { kind: "unknown" }
  switch (resolved.type) {
    case "enum":
      return { kind: "primitive" }
    case "objectRef":
      return typeof resolved.objectTypeId === "string"
        ? { kind: "objectRef", objectTypeId: resolved.objectTypeId }
        : { kind: "unknown" }
    case "object":
      return isRecord(resolved.properties)
        ? {
            kind: "object",
            fields: Object.fromEntries(
              Object.entries(resolved.properties).map(([id, field]) => [
                id,
                { schema: isRecord(field) ? field.schema : undefined, valueTypes },
              ])
            ),
          }
        : { kind: "unknown" }
    case "array":
      return { kind: "array", items: { schema: resolved.items, valueTypes } }
    case "map":
      return { kind: "map", values: { schema: resolved.valueSchema, valueTypes } }
    default:
      return { kind: "unknown" }
  }
}

function childSchema(node: ValueSchemaNode, key: string): ValueSchema {
  if (node.kind === "object")
    return Object.hasOwn(node.fields, key) ? node.fields[key] : unknownSchema
  if (node.kind === "array") return node.items
  if (node.kind === "map") return node.values
  return unknownSchema
}

interface ObjectRefValue {
  readonly objectTypeId: string
  readonly primaryId: string
}

interface Position {
  readonly objectRef: ObjectRefValue | null
  readonly fileRef: FileRef | null
  readonly userRef: UserRef | null
  /** The schema of a child; `undefined` (open) below an open value. */
  readonly child: (key: string) => ValueSchema | undefined
}

// With a schema only the schema decides; without one, the value's shape is all there is. A user
// is never guessed: `{ type: "user", id }` is too common a shape.
function readPosition(value: unknown, schema: ValueSchema | undefined): Position {
  if (!schema) {
    return {
      objectRef: isObjectRefShape(value) ? value : null,
      fileRef: isFileRef(value) ? value : null,
      userRef: null,
      child: () => undefined,
    }
  }
  const node = describe(schema)
  return {
    objectRef:
      node.kind === "objectRef" &&
      isRecord(value) &&
      typeof value.objectTypeId === "string" &&
      typeof value.primaryId === "string"
        ? { objectTypeId: value.objectTypeId, primaryId: value.primaryId }
        : null,
    fileRef: node.kind === "fileRef" && isFileRef(value) ? value : null,
    userRef:
      node.kind === "userRef" &&
      isRecord(value) &&
      value.type === "user" &&
      typeof value.id === "string" &&
      value.id.length > 0
        ? { type: "user", id: value.id }
        : null,
    child: (key) => childSchema(node, key),
  }
}

export interface FileLinks {
  readonly inlineUrl: string
  readonly downloadUrl: string
}

/** The links to the file at a path in the value, or `null` when it cannot be opened. */
export type FileLinksAt = (path: readonly string[]) => FileLinks | null

/**
 * Links to a file inside a recorded value, served by a run's `files/content` route. `root` is the
 * value's place in the run, such as `params` or `input`.
 */
export function runFileLinks(apiUrl: string, routePath: string, root: string): FileLinksAt {
  return (path) => {
    const url = new URL(routePath, apiUrl)
    const pointer = [root, ...path].map((segment) =>
      segment.replace(/~/g, "~0").replace(/\//g, "~1")
    )
    url.searchParams.set("path", `/${pointer.join("/")}`)
    const inlineUrl = url.toString()
    url.searchParams.set("disposition", "attachment")
    return { inlineUrl, downloadUrl: url.toString() }
  }
}

/** A recorded value under a heading, readable or as raw JSON. */
export function ValuePanel({
  title,
  value,
  schema,
  fileLinks,
  emptyLabel,
}: {
  readonly title: string
  readonly value: unknown
  /** The value's declared schema; leave it out only for values nobody declared. */
  readonly schema?: ValueSchema
  readonly fileLinks?: FileLinksAt
  readonly emptyLabel?: string
}) {
  const messages = useValueMessages()
  const [raw, setRaw] = useState(false)
  // An empty record or list says so in the panel's own words, such as "No input".
  const empty =
    value === null ||
    value === undefined ||
    (Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0)
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]">
      <div className="flex h-11 items-center justify-between gap-3 border-b border-border px-4">
        <h3 className="text-[0.8125rem] font-semibold">{title}</h3>
        {empty ? null : (
          <div className="inline-flex rounded-md bg-muted/70 p-0.5">
            {[false, true].map((option) => (
              <button
                key={String(option)}
                type="button"
                aria-pressed={raw === option}
                onClick={() => setRaw(option)}
                className={cn(
                  "rounded-[5px] px-2 py-0.5 text-[0.6875rem] font-medium transition-colors",
                  raw === option
                    ? "bg-background text-foreground ring-1 ring-border"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {option ? messages.raw : messages.structured}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="px-4 py-3.5">
        {empty ? (
          <p className="text-[0.8125rem] text-muted-foreground">{emptyLabel ?? messages.empty}</p>
        ) : raw ? (
          <pre className="max-h-96 overflow-auto font-mono text-xs leading-5 break-all whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(value, null, 2)}
          </pre>
        ) : (
          <ValueView value={value} schema={schema} fileLinks={fileLinks} />
        )}
      </div>
    </section>
  )
}

/** A value as a tree of labelled fields. */
function ValueView({
  value,
  schema,
  fileLinks,
  path = [],
}: {
  readonly value: unknown
  readonly schema?: ValueSchema
  readonly fileLinks?: FileLinksAt
  readonly path?: readonly string[]
}) {
  const messages = useValueMessages()
  const position = readPosition(value, schema)
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : isRecord(value) && !position.objectRef && !position.fileRef && !position.userRef
      ? Object.entries(value)
      : null

  if (!entries) {
    return <Leaf value={value} position={position} fileLinks={fileLinks} path={path} />
  }
  if (entries.length === 0) {
    return (
      <p className="text-[0.8125rem] text-muted-foreground">
        {Array.isArray(value) ? messages.emptyList : messages.emptyRecord}
      </p>
    )
  }
  return (
    <dl className="divide-y divide-border/60 text-[0.8125rem]">
      {entries.map(([key, item]) => (
        <Field
          key={key}
          label={Array.isArray(value) ? `${Number(key) + 1}` : key}
          value={item}
          schema={position.child(key)}
          fileLinks={fileLinks}
          path={[...path, key]}
        />
      ))}
    </dl>
  )
}

function Field({
  label,
  value,
  schema,
  fileLinks,
  path,
}: {
  readonly label: string
  readonly value: unknown
  readonly schema: ValueSchema | undefined
  readonly fileLinks?: FileLinksAt
  readonly path: readonly string[]
}) {
  const messages = useValueMessages()
  const position = readPosition(value, schema)
  const plain = !position.objectRef && !position.fileRef && !position.userRef
  const count = !plain
    ? null
    : Array.isArray(value)
      ? value.length
      : isRecord(value)
        ? Object.keys(value).length
        : null
  const long = typeof value === "string" && (value.length > 80 || value.includes("\n"))

  if (count !== null) {
    return (
      <div className="py-2.5 first:pt-0 last:pb-0">
        <dt className="flex items-baseline gap-2">
          <span className="font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">
            {Array.isArray(value) ? messages.items(count) : messages.fields(count)}
          </span>
        </dt>
        {count > 0 ? (
          <dd className="mt-2 border-l border-border pl-3">
            <ValueView value={value} schema={schema} fileLinks={fileLinks} path={path} />
          </dd>
        ) : null}
      </div>
    )
  }
  return (
    <div
      className={cn(
        "grid gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0",
        long || position.fileRef ? "" : "sm:grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)]"
      )}
    >
      <dt className="min-w-0 font-medium break-words">{label}</dt>
      <dd className="min-w-0">
        <Leaf value={value} position={position} fileLinks={fileLinks} path={path} />
      </dd>
    </div>
  )
}

function Leaf({
  value,
  position,
  fileLinks,
  path,
}: {
  readonly value: unknown
  readonly position: Position
  readonly fileLinks?: FileLinksAt
  readonly path: readonly string[]
}) {
  const messages = useValueMessages()
  if (position.objectRef) {
    return (
      <Ref icon={<Box className="size-3 text-emerald-600 dark:text-emerald-400" />}>
        {position.objectRef.objectTypeId}
        <span className="font-mono text-muted-foreground" title={position.objectRef.primaryId}>
          {position.objectRef.primaryId}
        </span>
      </Ref>
    )
  }
  if (position.userRef) {
    return (
      <Ref icon={<UserRound className="size-3 text-sky-600 dark:text-sky-400" />}>
        {messages.user}
        <span className="font-mono text-muted-foreground">{position.userRef.id}</span>
      </Ref>
    )
  }
  if (position.fileRef) {
    return <FileValue file={position.fileRef} links={fileLinks?.(path) ?? null} />
  }
  if (typeof value === "string") {
    return value.length > 80 || value.includes("\n") ? (
      <LongText text={value} />
    ) : (
      <span className="break-words">{value}</span>
    )
  }
  if (value === null || value === undefined) {
    return <span className="font-mono text-xs text-muted-foreground/70 italic">null</span>
  }
  return <span className="font-mono text-xs break-all">{JSON.stringify(value)}</span>
}

function Ref({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium [&>span]:truncate">
      {icon}
      {children}
    </span>
  )
}

function FileValue({ file, links }: { readonly file: FileRef; readonly links: FileLinks | null }) {
  const messages = useValueMessages()
  const locale = useLocale()
  const name = fileNameFor(file)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-background px-3 py-2 text-xs">
      <span className="inline-flex min-w-0 flex-1 items-center gap-2">
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium" title={name}>
          {name}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {file.mediaType ?? messages.file} · {formatBytes(file.sizeBytes, locale)}
        </span>
      </span>
      {links ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <a
            href={links.inlineUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Eye className="size-3.5" />
            {messages.view}
          </a>
          <a
            href={links.downloadUrl}
            download={name}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Download className="size-3.5" />
            {messages.download}
          </a>
        </span>
      ) : null}
    </div>
  )
}

function LongText({ text }: { readonly text: string }) {
  const messages = useValueMessages()
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)
  // Measured only while clamped: expanded, the paragraph grows to fit.
  useLayoutEffect(() => {
    const element = ref.current
    if (element && !expanded) setOverflowing(element.scrollHeight > element.clientHeight + 1)
  }, [expanded])
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p
          ref={ref}
          className={cn(
            "leading-relaxed break-words whitespace-pre-wrap",
            expanded ? "max-h-96 overflow-y-auto" : "line-clamp-3"
          )}
        >
          {text}
        </p>
        {overflowing ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="mt-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? messages.showLess : messages.showMore}
          </button>
        ) : null}
      </div>
      <CopyButton value={text} compact />
    </div>
  )
}

function formatBytes(value: number, locale: string): string {
  if (!Number.isFinite(value) || value < 0) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4)
  const scaled = value / 1024 ** index
  const digits = scaled >= 10 || index === 0 ? 0 : 1
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(scaled)} ${units[index]}`
}

function isObjectRefShape(value: unknown): value is ObjectRefValue {
  return (
    isRecord(value) &&
    typeof value.objectTypeId === "string" &&
    typeof value.primaryId === "string" &&
    Object.keys(value).every((key) => key === "objectTypeId" || key === "primaryId")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
