import { cn } from "@sixb/ui/lib/utils"
import {
  Box,
  Braces,
  Brackets,
  Calendar,
  Check,
  Clock,
  FileText,
  Fingerprint,
  Hash,
  List,
  Paperclip,
  Tag,
  Type,
} from "lucide-react"
import type { ComponentType, ReactNode } from "react"

type Shape = Readonly<Record<string, unknown>>

export function SchemaShape({
  fields,
  emptyLabel = "No fields",
}: {
  fields: Shape | null | undefined
  emptyLabel?: string
}) {
  const entries = fields ? Object.entries(fields) : []
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }
  return (
    <ul className="divide-y divide-border/40 text-sm">
      {entries.map(([name, descriptor]) => (
        <SchemaFieldRow key={name} name={name} descriptor={descriptor} />
      ))}
    </ul>
  )
}

function SchemaFieldRow({ name, descriptor }: { name: string; descriptor: unknown }) {
  const wrapped = unwrapFieldDescriptor(descriptor)
  return (
    <li className="group flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="break-all font-mono text-[13px] font-medium text-foreground">
            {name}
          </span>
          {wrapped.hasRequiredFlag && !wrapped.required ? <Pill>optional</Pill> : null}
          {wrapped.nullable ? <Pill>nullable</Pill> : null}
        </div>
        {wrapped.description ? (
          <p className="text-xs leading-snug text-muted-foreground">{wrapped.description}</p>
        ) : null}
      </div>
      <span className="shrink-0">
        <SchemaChip schema={wrapped.schema} />
      </span>
    </li>
  )
}

export function SchemaChip({ schema }: { schema: unknown }) {
  const info = describeSchema(schema)
  const Icon = info.icon
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground">
      <Icon className={cn("h-3 w-3", info.iconClass)} />
      <span>{info.label}</span>
      {info.detail ? <span className="text-muted-foreground">{info.detail}</span> : null}
    </span>
  )
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded border border-border/70 px-1 py-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  )
}

type DescribedSchema = {
  label: string
  detail?: string
  icon: ComponentType<{ className?: string }>
  iconClass?: string
}

function describeSchema(schema: unknown): DescribedSchema {
  if (typeof schema === "string") {
    return describePrimitive(schema)
  }

  if (!isRecord(schema)) {
    return { label: "any", icon: Braces }
  }

  if (schema.type === "objectRef" && typeof schema.objectTypeId === "string") {
    return {
      label: schema.objectTypeId,
      detail: "object",
      icon: Box,
      iconClass: "text-emerald-600 dark:text-emerald-400",
    }
  }

  if (schema.type === "valueTypeRef" && typeof schema.valueTypeId === "string") {
    return { label: schema.valueTypeId, detail: "value type", icon: Tag }
  }

  if (schema.type === "enum" && Array.isArray(schema.values)) {
    const count = schema.values.length
    return {
      label: "enum",
      detail: `${count} ${count === 1 ? "value" : "values"}`,
      icon: List,
    }
  }

  if (schema.type === "array") {
    const inner = describeSchema(schema.items)
    return {
      label: "array",
      detail: `of ${inner.label}`,
      icon: Brackets,
    }
  }

  if (schema.type === "map") {
    const inner = describeSchema(schema.valueSchema)
    return {
      label: "map",
      detail: `→ ${inner.label}`,
      icon: Braces,
    }
  }

  if (schema.type === "object" && isRecord(schema.properties)) {
    const count = Object.keys(schema.properties as object).length
    return {
      label: "object",
      detail: `${count} ${count === 1 ? "field" : "fields"}`,
      icon: Braces,
    }
  }

  return { label: "any", icon: Braces }
}

function describePrimitive(primitive: string): DescribedSchema {
  switch (primitive) {
    case "string":
      return { label: "string", icon: Type }
    case "integer":
      return { label: "integer", icon: Hash }
    case "double":
    case "decimal":
      return { label: primitive, icon: Hash }
    case "boolean":
      return { label: "boolean", icon: Check }
    case "date":
      return { label: "date", icon: Calendar }
    case "timestamp":
      return { label: "timestamp", icon: Clock }
    case "uuid":
      return { label: "uuid", icon: Fingerprint }
    case "fileRef":
      return { label: "file", icon: Paperclip }
    default:
      return { label: primitive, icon: FileText, iconClass: "text-muted-foreground" }
  }
}

function unwrapFieldDescriptor(descriptor: unknown): {
  schema: unknown
  required: boolean
  hasRequiredFlag: boolean
  nullable: boolean
  description?: string
} {
  if (isRecord(descriptor) && "schema" in descriptor) {
    const required = typeof descriptor.required === "boolean" ? descriptor.required : false
    return {
      schema: descriptor.schema,
      required,
      hasRequiredFlag: true,
      nullable: descriptor.nullable === true,
      description: typeof descriptor.description === "string" ? descriptor.description : undefined,
    }
  }
  return {
    schema: descriptor,
    required: true,
    hasRequiredFlag: false,
    nullable: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
